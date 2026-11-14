import type { SourceRef } from '../../contracts/src/model.ts';
import {
  PACK_ENGINE_VERSION,
  type Behavior, type Condition, type DeadlineSpec, type FactValue, type PackRelease, type PackRule, type ScenarioSpec
} from '../../contracts/src/pack.ts';
import { assessApplicability } from '../../legislation/src/baselines.ts';
import { evaluateRuleGuard, type RuleSpec } from '../../rules/src/language.ts';
import { calculateHypotheticalDeadline, type LegalCalendar } from './calendar.ts';
import type { ComparisonCheckpoint } from './comparison.ts';
import { assessDuty } from './duties.ts';
import { DeterministicScheduler } from './scheduler.ts';

/**
 * LM-030 pack interpreter. Executes a compiled release against one framework
 * and one hypothetical scenario. Law and behavior stay separate: a rule can
 * create a duty, but only a declared operational assumption makes an actor
 * perform it. Unknown facts stay unknown, and nothing here reads a clock.
 * One tick is one civil day in the scenario calendar.
 */
export type EventCategory =
  | 'external' | 'rule' | 'duty' | 'performance' | 'breach' | 'clock' | 'arrival'
  | 'exception' | 'not-effective' | 'unresolved';
export type PackEvent = {
  readonly id: string; readonly seq: number; readonly day: number; readonly date: string;
  readonly kind: string; readonly label: string; readonly actorId: string;
  readonly category: EventCategory;
  /** `legal` events follow from a cited rule; `operational` ones from a scenario assumption. */
  readonly basis: 'legal' | 'operational' | 'scenario';
  readonly ruleId: string | null; readonly causeId: string | null; readonly dutyId: string | null;
  readonly checkpoint: string | null;
  readonly outcome: 'recorded' | 'pending' | 'satisfied' | 'breached' | 'not-applicable' | 'unknown';
  readonly dueDay: number | null; readonly dueDate: string | null;
  readonly predicates: readonly { readonly factId: string; readonly value: FactValue | null }[];
  readonly appliedExceptions: readonly string[];
  readonly sourceRefs: readonly SourceRef[];
  readonly assumptionIds: readonly string[];
  readonly unresolved: readonly string[];
  readonly explanationKey: string | null;
};
export type DutyRecord = {
  readonly id: string; readonly ruleId: string; readonly actorId: string; readonly action: string;
  readonly createdDay: number; readonly createdDate: string;
  readonly deadline: 'resolved' | 'unresolved' | 'none';
  readonly dueDay: number | null; readonly dueDate: string | null;
  readonly state: 'pending' | 'satisfied' | 'breached' | 'unknown';
  readonly performedDay: number | null; readonly performedDate: string | null;
  readonly reasons: readonly string[];
  readonly checkpoint: string | null;
  readonly sourceRefs: readonly SourceRef[];
};
export type StatusRecord = { readonly id: string; readonly force: 'right' | 'permission' | 'prohibition'; readonly holderId: string; readonly action: string; readonly ruleId: string; readonly day: number; readonly sourceRefs: readonly SourceRef[] };
export type PackRun = {
  readonly engineVersion: typeof PACK_ENGINE_VERSION;
  readonly packId: string; readonly frameworkId: string; readonly scenarioId: string;
  readonly state: 'resolved' | 'unresolved' | 'limited';
  readonly hypotheticalEnactment: boolean;
  readonly events: readonly PackEvent[];
  readonly duties: readonly DutyRecord[];
  readonly statuses: readonly StatusRecord[];
  readonly facts: Readonly<Record<string, FactValue>>;
  readonly checkpoints: readonly ComparisonCheckpoint[];
  readonly beyondHorizon: readonly { readonly kind: string; readonly day: number; readonly date: string }[];
  readonly warnings: readonly string[];
  readonly horizonDay: number;
};
export type RunOptions = {
  readonly maxEvents?: number;
  /** Operational performance day per duty action, e.g. produced by a queue model. `null` = never. */
  readonly performance?: Readonly<Record<string, number | null>>;
};

const dayMs = 86400000;
export const addDays = (isoDate: string, days: number): string => new Date(Date.parse(isoDate + 'T00:00:00Z') + days * dayMs).toISOString().slice(0, 10);
export const diffDays = (later: string, earlier: string): number => Math.round((Date.parse(later + 'T00:00:00Z') - Date.parse(earlier + 'T00:00:00Z')) / dayMs);
export function isBusinessDay(calendar: LegalCalendar, isoDate: string): boolean {
  return !calendar.weekendDays.includes(new Date(isoDate + 'T00:00:00Z').getUTCDay()) && !calendar.observedHolidays.includes(isoDate);
}
export function addOperationalDelay(calendar: LegalCalendar, from: string, amount: number, unit: 'calendar-day' | 'business-day'): string {
  if (unit === 'calendar-day') return addDays(from, amount);
  let current = from;
  for (let remaining = amount, guard = 0; remaining > 0 && guard < 20000; guard++) {
    current = addDays(current, 1);
    if (isBusinessDay(calendar, current)) remaining--;
  }
  return current;
}
function referencedFacts(condition: Condition, out: Set<string>): void {
  if (condition.op === 'truth') { if (condition.value.op === 'fact-value') out.add(condition.value.key); }
  else if (condition.op === 'eq' || condition.op === 'gte' || condition.op === 'lte') {
    for (const side of [condition.left, condition.right]) if (side.op === 'fact-value') out.add(side.key);
  } else if (condition.op === 'not') referencedFacts(condition.arg, out);
  else if (condition.op === 'and' || condition.op === 'or') for (const term of condition.terms) referencedFacts(term, out);
}
export function legalCalendar(release: PackRelease, calendarId: string): LegalCalendar {
  const c = release.calendars.find(item => item.id === calendarId);
  if (!c) throw Error('CALENDAR_UNKNOWN');
  return { id: c.id, version: c.version, timeZone: c.timeZone, weekendDays: c.weekendDays, observedHolidays: c.observedHolidays };
}
export function resolveDeadline(calendar: LegalCalendar, spec: DeadlineSpec<SourceRef>, triggerDate: string) {
  return calculateHypotheticalDeadline(calendar, {
    id: spec.id, calendarId: spec.calendarId, calendarVersion: calendar.version, amount: spec.amount, unit: spec.unit,
    startCounting: spec.startCounting, monthEnd: spec.monthEnd, nonBusinessDue: spec.nonBusinessDue,
    cutoffTime: null, afterCutoff: 'same-day', sourceRefs: spec.sourceRefs
  }, triggerDate);
}

type Pending =
  | { readonly type: 'event'; readonly category: EventCategory; readonly basis: PackEvent['basis']; readonly label: string; readonly ruleId: string | null; readonly sourceRefs: readonly SourceRef[]; readonly assumptionIds: readonly string[]; readonly checkpoint: string | null }
  | { readonly type: 'perform'; readonly dutyId: string; readonly assumptionIds: readonly string[] }
  | { readonly type: 'deadline'; readonly dutyId: string };
type MutableDuty = { -readonly [K in keyof DutyRecord]: DutyRecord[K] } & { onPerformEmits: string; onBreachEmits: string | null; breachRecorded: boolean };

export function runPackScenario(release: PackRelease, frameworkId: string, scenario: ScenarioSpec, options: RunOptions = {}): PackRun {
  const framework = release.frameworks.find(f => f.id === frameworkId);
  if (!framework) throw Error('FRAMEWORK_UNKNOWN');
  if (!scenario || scenario.hypothetical !== true) throw Error('SCENARIO_NOT_HYPOTHETICAL');
  const hypotheticalEnactment = framework.role === 'proposal' && framework.status !== 'enacted';
  // A proposal never runs as operative law unless the scenario states the assumption.
  if (hypotheticalEnactment && scenario.enactment.assume !== true) throw Error('ENACTMENT_ASSUMPTION_REQUIRED');
  const calendar = legalCalendar(release, scenario.calendarId);
  const horizon = scenario.horizonDays;
  const dateOf = (day: number) => addDays(scenario.startDate, day);
  const enactedOn = dateOf(scenario.enactment.offsetDays);
  const ruleById = new Map(framework.rules.map(r => [r.id, r]));
  const deadlineById = new Map(release.deadlines.map(d => [d.id, d]));
  const behaviorByAction = new Map<string, Behavior>(scenario.behaviors.map(b => [b.action, b]));
  const facts: Record<string, FactValue> = { ...scenario.facts };
  for (const conflict of release.interpretations) {
    const choice = scenario.interpretationChoices[conflict.id] ?? conflict.chosen?.alternativeId;
    if (choice !== undefined) facts['interp.' + conflict.id] = choice;
  }
  const warnings = new Set<string>();
  if (hypotheticalEnactment) warnings.add('HYPOTHETICAL_ENACTMENT_NOT_CURRENT_LAW');
  if (framework.role === 'baseline' && scenario.startDate < framework.asOf) warnings.add('SCENARIO_PREDATES_BASELINE_SNAPSHOT');
  if (framework.gaps.length) warnings.add('FRAMEWORK_HAS_DECLARED_GAPS');

  const budget = Math.max(1, Math.min(Math.floor(options.maxEvents ?? 5000), 100000));
  const scheduler = new DeterministicScheduler(budget, Math.min(1000, budget));
  const pending = new Map<string, Pending>();
  const events: PackEvent[] = [];
  const duties = new Map<string, MutableDuty>();
  const statuses: StatusRecord[] = [];
  const checkpoints = new Map<string, ComparisonCheckpoint>();
  const beyondHorizon: { kind: string; day: number; date: string }[] = [];
  let created = 0;
  let unresolvedSeen = false;
  const label = (kind: string) => release.eventLabels[kind] ?? kind;
  const schedule = (day: number, kind: string, actorId: string, causeId: string | null, payload: Pending): string | null => {
    if (day > horizon) { beyondHorizon.push({ kind, day, date: dateOf(day) }); return null; }
    // Same-day order is creation order: scripted events as declared, then derived events causally.
    const eventId = 'e' + String(++created).padStart(5, '0');
    pending.set(eventId, payload);
    scheduler.schedule({ id: eventId, tick: day, actorId, kind, causeId, sourceRefs: payload.type === 'event' && payload.sourceRefs.length ? payload.sourceRefs.map(r => r.provisionId) : ['scenario:' + scenario.id] });
    return eventId;
  };
  const force = (rule: PackRule<SourceRef>): ComparisonCheckpoint['legalForce'] => rule.modal === 'power' ? 'permission' : rule.modal;
  const mark = (key: string | undefined, value: Omit<ComparisonCheckpoint, 'semanticKey'>) => {
    if (key) checkpoints.set(key, { semanticKey: key, ...value });
  };
  const provisionIds = (refs: readonly SourceRef[]) => [...new Set(refs.map(r => r.provisionId))];
  let derived = 0;
  const push = (e: Omit<PackEvent, 'seq' | 'date' | 'label' | 'id'> & { label?: string; id?: string }): PackEvent => {
    // Rule applications are derived records of their trigger; they get stable causal IDs.
    const eventId = e.id ?? 'r' + String(++derived).padStart(5, '0');
    const event: PackEvent = { ...e, id: eventId, seq: events.length, date: dateOf(e.day), label: e.label ?? label(e.kind) };
    events.push(event);
    return event;
  };
  const base = { dutyId: null, dueDay: null, dueDate: null, predicates: [], appliedExceptions: [], assumptionIds: [], unresolved: [], explanationKey: null } as const;

  for (const scripted of scenario.events)
    schedule(scripted.day, scripted.kind, scripted.actorId, null, { type: 'event', category: 'external', basis: 'scenario', label: scripted.label, ruleId: null, sourceRefs: [], assumptionIds: [], checkpoint: null });

  function fire(trigger: PackEvent): void {
    for (const ruleId of framework!.ruleOrder) {
      const rule = ruleById.get(ruleId)!;
      if (rule.trigger !== trigger.kind) continue;
      const effect = rule.effect;
      const shared = { ...base, day: trigger.day, kind: rule.id, actorId: rule.actorId, ruleId: rule.id, causeId: trigger.id, sourceRefs: rule.sourceRefs, explanationKey: rule.explanationKey, checkpoint: effect.checkpoint ?? null };
      if (framework!.role === 'proposal') {
        const applicability = assessApplicability(
          { id: rule.id, status: framework!.status, effectiveOn: addDays(enactedOn, effect.effectiveAfterEnactmentDays ?? 0) },
          trigger.date, { hypotheticalEnactment: scenario.enactment.assume });
        if (applicability.state !== 'applicable') {
          push({ ...shared, label: effect.summary, category: 'not-effective', basis: 'legal', outcome: 'not-applicable', unresolved: applicability.state === 'not-effective' ? [] : [...applicability.reasons] });
          if (applicability.state !== 'not-effective') unresolvedSeen = true;
          continue;
        }
      }
      const guard = evaluateRuleGuard({ when: rule.when, exceptions: rule.exceptions } as unknown as RuleSpec, facts);
      const keys = new Set<string>();
      referencedFacts(rule.when, keys);
      for (const exception of rule.exceptions) referencedFacts(exception, keys);
      const predicates = [...keys].sort().map(factId => ({ factId, value: Object.hasOwn(facts, factId) ? facts[factId]! : null }));
      if (guard.applicable === 'unknown') {
        const missing = predicates.filter(p => p.value === null).map(p => p.factId);
        unresolvedSeen = true;
        push({ ...shared, label: effect.summary, category: 'unresolved', basis: 'legal', outcome: 'unknown', predicates, unresolved: missing.length ? missing : ['CONDITION_UNRESOLVED'] });
        mark(effect.checkpoint, { eventId: 'unresolved', legalForce: 'unknown', dutyState: 'unknown', eventTick: null, dueTick: null, workloadUnits: null, sourceRefs: provisionIds(rule.sourceRefs), unresolved: missing.length ? missing : ['CONDITION_UNRESOLVED'] });
        continue;
      }
      if (guard.applicable === false) {
        if (guard.when === true && guard.exception === true) {
          const applied = rule.exceptions.flatMap((condition, index) =>
            evaluateRuleGuard({ when: condition, exceptions: [] } as unknown as RuleSpec, facts).when === true ? [effect.exceptions?.[index]?.id ?? 'exception-' + index] : []);
          const refs = (effect.exceptions ?? []).filter(x => applied.includes(x.id)).flatMap(x => x.sourceRefs);
          push({ ...shared, label: effect.summary, category: 'exception', basis: 'legal', outcome: 'not-applicable', predicates, appliedExceptions: applied, sourceRefs: refs.length ? refs : rule.sourceRefs });
        }
        continue;
      }
      if (effect.kind === 'record') {
        if (effect.transfer) {
          const amount = facts[effect.transfer.amountFact], from = facts[effect.transfer.account], to = facts[effect.transfer.to];
          if (typeof amount !== 'number' || typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
            unresolvedSeen = true;
            push({ ...shared, label: effect.summary, category: 'unresolved', basis: 'legal', outcome: 'unknown', predicates, unresolved: ['RESOURCE_AMOUNT_UNKNOWN'] });
            continue;
          }
          if (from < amount) {
            push({ ...shared, label: effect.summary, category: 'exception', basis: 'legal', outcome: 'not-applicable', predicates, unresolved: ['INSUFFICIENT_BALANCE'] });
            continue;
          }
          // Integer accounting: every unit leaving one account arrives in the other.
          facts[effect.transfer.account] = from - amount;
          facts[effect.transfer.to] = to + amount;
        }
        Object.assign(facts, effect.setFacts ?? {});
        const recorded = push({ ...shared, label: effect.summary, category: 'rule', basis: 'legal', outcome: 'recorded', predicates });
        if (effect.status) statuses.push({ id: 'status-' + (statuses.length + 1), ...effect.status, ruleId: rule.id, day: trigger.day, sourceRefs: rule.sourceRefs });
        mark(effect.checkpoint, { eventId: recorded.id, legalForce: force(rule), dutyState: 'none', eventTick: trigger.day, dueTick: null, workloadUnits: null, sourceRefs: provisionIds(rule.sourceRefs), unresolved: [] });
        if (effect.emits) schedule(trigger.day, effect.emits, rule.actorId, recorded.id, { type: 'event', category: 'rule', basis: 'legal', label: label(effect.emits), ruleId: rule.id, sourceRefs: rule.sourceRefs, assumptionIds: [], checkpoint: null });
      } else if (effect.kind === 'create-obligation') {
        const spec = effect.deadlineId === null ? null : deadlineById.get(effect.deadlineId)!;
        const due = spec ? resolveDeadline(calendar, spec, trigger.date) : null;
        const dueDay = due?.state === 'resolved' && due.dueDate ? diffDays(due.dueDate, scenario.startDate) : null;
        const dutyId = 'duty-' + (duties.size + 1);
        const duty: MutableDuty = {
          id: dutyId, ruleId: rule.id, actorId: rule.actorId, action: effect.action, createdDay: trigger.day, createdDate: trigger.date,
          deadline: !spec ? 'none' : dueDay === null ? 'unresolved' : 'resolved', dueDay, dueDate: dueDay === null ? null : dateOf(dueDay),
          state: 'pending', performedDay: null, performedDate: null, reasons: due?.state === 'unresolved' ? [...due.reasons] : ['AWAITING_PERFORMANCE'],
          checkpoint: effect.checkpoint ?? null, sourceRefs: [...rule.sourceRefs, ...(spec?.sourceRefs ?? [])],
          onPerformEmits: effect.onPerformEmits, onBreachEmits: effect.onBreachEmits ?? null, breachRecorded: false
        };
        duties.set(dutyId, duty);
        if (duty.deadline === 'unresolved') unresolvedSeen = true;
        const recorded = push({ ...shared, label: effect.summary, category: 'duty', basis: 'legal', outcome: 'pending', dutyId, dueDay, dueDate: duty.dueDate, predicates, sourceRefs: duty.sourceRefs, unresolved: duty.deadline === 'unresolved' ? duty.reasons : [] });
        mark(effect.checkpoint, { eventId: recorded.id, legalForce: force(rule), dutyState: 'pending', eventTick: null, dueTick: dueDay, workloadUnits: null, sourceRefs: provisionIds(duty.sourceRefs), unresolved: duty.deadline === 'unresolved' ? ['DEADLINE_UNRESOLVED'] : [] });
        // The duty exists either way; only a labeled operational assumption performs it.
        const behavior = behaviorByAction.get(effect.action);
        const override = options.performance && Object.hasOwn(options.performance, effect.action) ? options.performance[effect.action] : undefined;
        const assumptionIds = behavior ? [behavior.assumptionId] : [];
        if (override !== undefined) { if (override !== null) schedule(Math.max(override, trigger.day), 'performed:' + effect.action, rule.actorId, recorded.id, { type: 'perform', dutyId, assumptionIds: scenario.workload ? [scenario.workload.assumptionId] : assumptionIds }); }
        else if (!behavior) { duty.state = 'unknown'; duty.reasons = ['BEHAVIOR_UNSPECIFIED']; warnings.add('BEHAVIOR_UNSPECIFIED:' + effect.action); unresolvedSeen = true; }
        else if (behavior.mode === 'perform-after') schedule(diffDays(addOperationalDelay(calendar, trigger.date, behavior.delay!.amount, behavior.delay!.unit), scenario.startDate), 'performed:' + effect.action, rule.actorId, recorded.id, { type: 'perform', dutyId, assumptionIds });
        if (dueDay !== null && duty.state !== 'unknown') schedule(dueDay + 1, 'deadline-passed:' + effect.action, rule.actorId, recorded.id, { type: 'deadline', dutyId });
      } else if (effect.kind === 'route') {
        const behavior = effect.transitAction ? behaviorByAction.get(effect.transitAction) : undefined;
        const recorded = push({ ...shared, label: effect.summary, category: 'rule', basis: 'legal', outcome: 'recorded', predicates });
        mark(effect.checkpoint, { eventId: recorded.id, legalForce: force(rule), dutyState: 'none', eventTick: trigger.day, dueTick: null, workloadUnits: null, sourceRefs: provisionIds(rule.sourceRefs), unresolved: [] });
        if (effect.transitAction && !behavior) { warnings.add('BEHAVIOR_UNSPECIFIED:' + effect.transitAction); unresolvedSeen = true; }
        else if (!behavior || behavior.mode === 'perform-after') {
          const arrival = behavior ? diffDays(addOperationalDelay(calendar, trigger.date, behavior.delay!.amount, behavior.delay!.unit), scenario.startDate) : trigger.day;
          schedule(arrival, effect.emits, effect.to, recorded.id, { type: 'event', category: 'arrival', basis: behavior ? 'operational' : 'legal', label: label(effect.emits), ruleId: rule.id, sourceRefs: rule.sourceRefs, assumptionIds: behavior ? [behavior.assumptionId] : [], checkpoint: null });
        }
      } else {
        // A period runs from its trigger unless the rule anchors it to an earlier event.
        const anchor = effect.anchorEvent ? events.find(e => e.kind === effect.anchorEvent && e.category !== 'not-effective') : trigger;
        if (!anchor) {
          unresolvedSeen = true;
          push({ ...shared, label: effect.summary, category: 'unresolved', basis: 'legal', outcome: 'unknown', predicates, unresolved: ['ANCHOR_EVENT_ABSENT'] });
          mark(effect.checkpoint, { eventId: 'unresolved', legalForce: 'unknown', dutyState: 'unknown', eventTick: null, dueTick: null, workloadUnits: null, sourceRefs: provisionIds(rule.sourceRefs), unresolved: ['ANCHOR_EVENT_ABSENT'] });
          continue;
        }
        const due = resolveDeadline(calendar, deadlineById.get(effect.deadlineId)!, anchor.date);
        const dueDay = due.state === 'resolved' && due.dueDate ? diffDays(due.dueDate, scenario.startDate) : null;
        const refs = [...rule.sourceRefs, ...deadlineById.get(effect.deadlineId)!.sourceRefs];
        if (dueDay === null) unresolvedSeen = true;
        const recorded = push({ ...shared, label: effect.summary, category: dueDay === null ? 'unresolved' : 'clock', basis: 'legal', outcome: dueDay === null ? 'unknown' : 'pending', dueDay, dueDate: dueDay === null ? null : dateOf(dueDay), predicates, sourceRefs: refs, unresolved: dueDay === null ? [...due.reasons] : [] });
        mark(effect.checkpoint, { eventId: recorded.id, legalForce: dueDay === null ? 'unknown' : force(rule), dutyState: 'none', eventTick: anchor.day, dueTick: dueDay, workloadUnits: null, sourceRefs: provisionIds(refs), unresolved: dueDay === null ? ['DEADLINE_UNRESOLVED'] : [] });
        // The emitted event marks that the period has ended: the day after its last day.
        if (dueDay !== null) schedule(Math.max(dueDay + 1, trigger.day), effect.emits, rule.actorId, recorded.id, { type: 'event', category: 'clock', basis: 'legal', label: label(effect.emits), ruleId: rule.id, sourceRefs: refs, assumptionIds: [], checkpoint: null });
      }
    }
  }

  const snapshot = scheduler.run(entry => {
    const payload = pending.get(entry.id)!;
    pending.delete(entry.id);
    if (payload.type === 'event') {
      const event = push({ ...base, id: entry.id, day: entry.tick, kind: entry.kind, label: payload.label, actorId: entry.actorId, category: payload.category, basis: payload.basis, ruleId: payload.ruleId, causeId: entry.causeId, checkpoint: payload.checkpoint, outcome: 'recorded', sourceRefs: payload.sourceRefs, assumptionIds: payload.assumptionIds });
      fire(event);
      return;
    }
    const duty = duties.get(payload.dutyId)!;
    const rule = ruleById.get(duty.ruleId)!;
    const point = duty.checkpoint ? checkpoints.get(duty.checkpoint) : undefined;
    if (payload.type === 'perform') {
      duty.performedDay = entry.tick; duty.performedDate = dateOf(entry.tick);
      if (duty.dueDay === null) { duty.state = duty.deadline === 'none' ? 'satisfied' : 'unknown'; duty.reasons = duty.deadline === 'none' ? ['PERFORMED_NO_STATED_DEADLINE'] : ['PERFORMED_TIMELINESS_UNRESOLVED']; }
      else {
        const assessed = assessDuty({ id: duty.id, actorId: duty.actorId, action: duty.action, createdTick: duty.createdDay, dueTick: duty.dueDay, sourceRuleId: duty.ruleId, sourceRefs: provisionIds(duty.sourceRefs) },
          { dutyId: duty.id, performedAt: entry.tick, evidenceId: entry.id }, entry.tick);
        duty.state = assessed.state; duty.reasons = [...assessed.reasons];
      }
      const event = push({ ...base, id: entry.id, day: entry.tick, kind: entry.kind, label: label('performed:' + duty.action), actorId: entry.actorId, category: 'performance', basis: 'operational', ruleId: duty.ruleId, causeId: entry.causeId, dutyId: duty.id, checkpoint: duty.checkpoint, outcome: duty.state, dueDay: duty.dueDay, dueDate: duty.dueDate, sourceRefs: duty.sourceRefs, assumptionIds: payload.assumptionIds, explanationKey: rule.explanationKey });
      if (point && duty.checkpoint) checkpoints.set(duty.checkpoint, { ...point, dutyState: duty.state, eventTick: entry.tick });
      schedule(entry.tick, duty.onPerformEmits, duty.actorId, event.id, { type: 'event', category: 'rule', basis: 'operational', label: label(duty.onPerformEmits), ruleId: duty.ruleId, sourceRefs: rule.sourceRefs, assumptionIds: payload.assumptionIds, checkpoint: null });
      return;
    }
    if (duty.performedDay !== null || duty.breachRecorded || duty.dueDay === null) return;
    const assessed = assessDuty({ id: duty.id, actorId: duty.actorId, action: duty.action, createdTick: duty.createdDay, dueTick: duty.dueDay, sourceRuleId: duty.ruleId, sourceRefs: provisionIds(duty.sourceRefs) }, null, entry.tick);
    duty.state = assessed.state; duty.reasons = [...assessed.reasons]; duty.breachRecorded = true;
    const event = push({ ...base, id: entry.id, day: entry.tick, kind: entry.kind, label: label('deadline-passed:' + duty.action), actorId: entry.actorId, category: 'breach', basis: 'legal', ruleId: duty.ruleId, causeId: entry.causeId, dutyId: duty.id, checkpoint: duty.checkpoint, outcome: 'breached', dueDay: duty.dueDay, dueDate: duty.dueDate, sourceRefs: duty.sourceRefs, explanationKey: rule.explanationKey });
    if (point && duty.checkpoint) checkpoints.set(duty.checkpoint, { ...point, dutyState: 'breached' });
    // A remedy never follows automatically: it needs its own rule triggered by this event.
    if (duty.onBreachEmits) schedule(entry.tick, duty.onBreachEmits, duty.actorId, event.id, { type: 'event', category: 'rule', basis: 'legal', label: label(duty.onBreachEmits), ruleId: duty.ruleId, sourceRefs: rule.sourceRefs, assumptionIds: [], checkpoint: null });
  });
  if (snapshot.status !== 'completed') warnings.add('RUN_TERMINATED:' + (snapshot.diagnostic?.code ?? 'UNKNOWN'));
  for (const duty of duties.values()) if (duty.state === 'unknown' && duty.checkpoint) {
    const point = checkpoints.get(duty.checkpoint);
    if (point) checkpoints.set(duty.checkpoint, { ...point, dutyState: 'unknown', unresolved: [...new Set([...point.unresolved, ...duty.reasons])] });
  }
  return {
    engineVersion: PACK_ENGINE_VERSION, packId: release.packId, frameworkId, scenarioId: scenario.id,
    state: snapshot.status !== 'completed' ? 'limited' : unresolvedSeen ? 'unresolved' : 'resolved',
    hypotheticalEnactment, events,
    duties: [...duties.values()].map(({ onPerformEmits: _a, onBreachEmits: _b, breachRecorded: _c, ...duty }) => { void _a; void _b; void _c; return duty; }),
    statuses, facts, checkpoints: [...checkpoints.values()].sort((a, b) => a.semanticKey.localeCompare(b.semanticKey, 'en')),
    beyondHorizon, warnings: [...warnings].sort(), horizonDay: horizon
  };
}
