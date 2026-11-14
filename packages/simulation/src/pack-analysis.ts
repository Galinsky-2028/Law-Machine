import { canonicalDigest, canonicalJSON } from '../../contracts/src/integrity.ts';
import type { SourceRef } from '../../contracts/src/model.ts';
import type { FactValue, PackRelease, ScenarioSpec } from '../../contracts/src/pack.ts';
import { compareFrameworks, type ComparisonChange, type FrameworkComparison } from './comparison.ts';
import { addDays, diffDays, isBusinessDay, legalCalendar, runPackScenario, type PackEvent, type PackRun } from './pack-engine.ts';
import { processQueue, type WorkItem } from './queues.ts';
import { namedStream, runIdentity, type ReplayDescriptor } from './replay.ts';

/** LM-026..LM-028, LM-036, LM-037: analysis built only from executed traces. */

// ---------- Parameters and labeled sandbox forks ----------
export type ParameterValue = boolean | number | string | null;
export type ParameterValues = Readonly<Record<string, ParameterValue>>;
export type ParameterIssue = { readonly parameterId: string; readonly message: string };
export type SandboxEdits = { readonly disabledRules?: Readonly<Record<string, readonly string[]>> };
export type PreparedScenario = {
  readonly scenario: ScenarioSpec; readonly release: PackRelease;
  /** True when any parameter differs from the pinned scenario or a rule is modified. */
  readonly modified: boolean; readonly modifiedRules: boolean;
  readonly labels: readonly string[]; readonly issues: readonly ParameterIssue[];
  readonly values: Readonly<Record<string, ParameterValue>>;
};

export function defaultParameterValues(scenario: ScenarioSpec): Record<string, ParameterValue> {
  const values: Record<string, ParameterValue> = {};
  for (const p of scenario.parameters) {
    const t = p.target;
    if (t.kind === 'fact') values[p.id] = Object.hasOwn(scenario.facts, t.factId) ? scenario.facts[t.factId]! : null;
    else if (t.kind === 'behavior-delay') values[p.id] = scenario.behaviors.find(b => b.action === t.action)?.delay?.amount ?? 0;
    else if (t.kind === 'behavior-mode') values[p.id] = scenario.behaviors.find(b => b.action === t.action)?.mode === 'never' ? 'never' : 'perform';
    else if (t.kind === 'interpretation') values[p.id] = scenario.interpretationChoices[t.interpretationId] ?? null;
    else values[p.id] = scenario.enactment.offsetDays;
  }
  return values;
}

/** Validate visitor inputs against the authored allowlist and produce a pinned, labeled fork. */
export function prepareScenario(release: PackRelease, scenarioId: string, input: ParameterValues = {}, edits: SandboxEdits = {}): PreparedScenario {
  const base = release.scenarios.find(s => s.id === scenarioId);
  if (!base) throw Error('SCENARIO_UNKNOWN');
  const defaults = defaultParameterValues(base);
  const issues: ParameterIssue[] = [];
  const facts: Record<string, FactValue> = { ...base.facts };
  let unknownFacts = [...base.unknownFacts];
  const behaviors = base.behaviors.map(b => ({ ...b, ...(b.delay ? { delay: { ...b.delay } } : {}) }));
  const choices: Record<string, string> = { ...base.interpretationChoices };
  let offset = base.enactment.offsetDays;
  const values: Record<string, ParameterValue> = { ...defaults };
  const labels: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    const p = base.parameters.find(x => x.id === key);
    if (!p) { issues.push({ parameterId: key, message: 'This setting is not adjustable in this scenario.' }); continue; }
    const t = p.target;
    if (p.control === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < p.min! || value > p.max!) { issues.push({ parameterId: key, message: p.label + ' must be a whole number from ' + p.min + ' to ' + p.max + (p.unit ? ' ' + p.unit : '') + '.' }); continue; }
    } else if (p.control === 'boolean') {
      if (typeof value !== 'boolean') { issues.push({ parameterId: key, message: p.label + ' must be yes or no.' }); continue; }
    } else if (p.control === 'tristate') {
      if (value !== null && typeof value !== 'boolean') { issues.push({ parameterId: key, message: p.label + ' must be yes, no or unknown.' }); continue; }
    } else if (!(value === null && t.kind === 'interpretation') && (typeof value !== 'string' || !p.options!.some(o => o.value === value))) { issues.push({ parameterId: key, message: p.label + ' must be one of the listed options.' }); continue; }
    values[key] = value;
    if (value !== defaults[key]) labels.push(p.label);
    if (t.kind === 'fact') {
      if (value === null) { delete facts[t.factId]; if (!unknownFacts.some(u => u.factId === t.factId)) unknownFacts = [...unknownFacts, { factId: t.factId, reason: 'Set to unknown by the visitor' }]; }
      else { facts[t.factId] = value as FactValue; unknownFacts = unknownFacts.filter(u => u.factId !== t.factId); }
    } else if (t.kind === 'behavior-delay') {
      const b = behaviors.find(x => x.action === t.action)!;
      behaviors[behaviors.indexOf(b)] = { ...b, mode: b.mode, delay: { amount: value as number, unit: b.delay?.unit ?? 'business-day' } };
    } else if (t.kind === 'behavior-mode') {
      const b = behaviors.find(x => x.action === t.action)!;
      behaviors[behaviors.indexOf(b)] = { ...b, mode: value === 'never' ? 'never' : 'perform-after', delay: b.delay ?? { amount: 0, unit: 'business-day' } };
    } else if (t.kind === 'interpretation') {
      // null keeps the conflict visibly unresolved instead of choosing a reading.
      if (value === null) delete choices[t.interpretationId]; else choices[t.interpretationId] = value as string;
    }
    else offset = value as number;
  }
  let modifiedRelease = release;
  const disabled = edits.disabledRules ?? {};
  const disabledCount = Object.values(disabled).reduce((n, list) => n + list.length, 0);
  if (disabledCount) {
    modifiedRelease = { ...release, frameworks: release.frameworks.map(f => {
      const off = new Set(disabled[f.id] ?? []);
      for (const r of off) if (!f.rules.some(x => x.id === r)) throw Error('SANDBOX_RULE_UNKNOWN');
      return off.size ? { ...f, label: f.label + ' (sandbox: ' + off.size + ' rule' + (off.size > 1 ? 's' : '') + ' removed)', rules: f.rules.filter(r => !off.has(r.id)), ruleOrder: f.ruleOrder.filter(r => !off.has(r)) } : f;
    }) };
    labels.push('Modified legal rules');
  }
  const scenario: ScenarioSpec = { ...base, facts, unknownFacts, behaviors, interpretationChoices: choices, enactment: { ...base.enactment, offsetDays: offset } };
  return { scenario, release: modifiedRelease, modified: labels.length > 0, modifiedRules: disabledCount > 0, labels, issues, values };
}

// ---------- Run identity, replay export and verification ----------
export type RunDigest = { readonly runId: string; readonly traceDigest: string };
export function replayDescriptor(manifestDigest: string, release: PackRelease, frameworkId: string, scenario: ScenarioSpec): ReplayDescriptor {
  const calendar = release.calendars.find(c => c.id === scenario.calendarId)!;
  return { engineVersion: release.engineVersion, calendarVersion: calendar.id + ':' + calendar.version, modelDigest: manifestDigest, scenarioId: scenario.id, seed: scenario.seed,
    facts: { framework: frameworkId, startDate: scenario.startDate, horizonDays: scenario.horizonDays, enactment: scenario.enactment, facts: scenario.facts,
      unknownFacts: scenario.unknownFacts.map(u => u.factId), interpretationChoices: scenario.interpretationChoices, events: scenario.events, behaviors: scenario.behaviors, workload: scenario.workload ?? null } };
}
export async function digestRun(manifestDigest: string, release: PackRelease, run: PackRun, scenario: ScenarioSpec): Promise<RunDigest> {
  const runId = await runIdentity(replayDescriptor(manifestDigest, release, run.frameworkId, scenario));
  const traceDigest = await canonicalDigest({ events: run.events.map(e => [e.id, e.day, e.kind, e.outcome, e.ruleId, e.dutyId]), duties: run.duties.map(d => [d.id, d.state, d.dueDay, d.performedDay]), facts: run.facts });
  return { runId, traceDigest };
}
export type RunExport = {
  readonly format: 'law-machine-run-v1'; readonly packId: string; readonly releaseId: string; readonly manifestDigest: string;
  readonly frameworkId: string; readonly scenarioId: string; readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly runId: string; readonly traceDigest: string; readonly engineVersion: string;
  /** `local` exports are computed in the visitor's browser; only the server can mark them verified. */
  readonly verification: { readonly kind: 'local' } | { readonly kind: 'server-verified'; readonly verifiedAt: string; readonly verifierKeyId: string; readonly signature: string };
  readonly summary: { readonly state: PackRun['state']; readonly duties: readonly { readonly action: string; readonly state: string; readonly dueDate: string | null; readonly performedDate: string | null }[] };
};
export async function exportRun(release: PackRelease, releaseId: string, manifestDigest: string, prepared: PreparedScenario, run: PackRun): Promise<RunExport> {
  if (prepared.modifiedRules) throw Error('SANDBOX_MODEL_NOT_EXPORTABLE_AS_PUBLISHED');
  const digest = await digestRun(manifestDigest, release, run, prepared.scenario);
  return { format: 'law-machine-run-v1', packId: release.packId, releaseId, manifestDigest, frameworkId: run.frameworkId, scenarioId: run.scenarioId,
    parameters: prepared.values, runId: digest.runId, traceDigest: digest.traceDigest, engineVersion: run.engineVersion, verification: { kind: 'local' },
    summary: { state: run.state, duties: run.duties.map(d => ({ action: d.action, state: d.state, dueDate: d.dueDate, performedDate: d.performedDate })) } };
}
export function parseRunExport(text: string): RunExport {
  if (typeof text !== 'string' || text.length > 200000) throw Error('RUN_EXPORT_SIZE');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw Error('RUN_EXPORT_JSON'); }
  const v = value as RunExport;
  const sha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  const id = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,160}$/.test(x);
  if (!v || v.format !== 'law-machine-run-v1' || !id(v.packId) || !id(v.releaseId) || !sha(v.manifestDigest) || !id(v.frameworkId) || !id(v.scenarioId) ||
      !sha(v.runId) || !sha(v.traceDigest) || !v.parameters || typeof v.parameters !== 'object' || Array.isArray(v.parameters) ||
      Object.keys(v.parameters).length > 40 || Object.values(v.parameters).some(x => !(x === null || ['boolean', 'number', 'string'].includes(typeof x)) || (typeof x === 'string' && x.length > 100)))
    throw Error('RUN_EXPORT_INVALID');
  return v;
}
/** Recompute a claimed result; a forged or altered outcome never verifies. */
export async function verifyRunExport(release: PackRelease, manifestDigest: string, claim: RunExport): Promise<{ readonly valid: boolean; readonly reason: string; readonly run: PackRun | null }> {
  if (claim.manifestDigest !== manifestDigest || claim.packId !== release.packId) return { valid: false, reason: 'RELEASE_MISMATCH', run: null };
  if (claim.engineVersion !== release.engineVersion) return { valid: false, reason: 'ENGINE_VERSION_UNSUPPORTED', run: null };
  let prepared: PreparedScenario;
  try { prepared = prepareScenario(release, claim.scenarioId, claim.parameters); } catch { return { valid: false, reason: 'SCENARIO_UNKNOWN', run: null }; }
  if (prepared.issues.length) return { valid: false, reason: 'PARAMETERS_INVALID', run: null };
  let run: PackRun;
  try { run = runPackScenario(release, claim.frameworkId, prepared.scenario); } catch (e) { return { valid: false, reason: e instanceof Error ? e.message : 'RUN_FAILED', run: null }; }
  const digest = await digestRun(manifestDigest, release, run, prepared.scenario);
  if (digest.runId !== claim.runId) return { valid: false, reason: 'RUN_IDENTITY_MISMATCH', run };
  if (digest.traceDigest !== claim.traceDigest) return { valid: false, reason: 'OUTCOME_MISMATCH', run };
  const summary = run.duties.map(d => ({ action: d.action, state: d.state, dueDate: d.dueDate, performedDate: d.performedDate }));
  if (canonicalJSON(summary) !== canonicalJSON(claim.summary?.duties ?? null) || claim.summary?.state !== run.state) return { valid: false, reason: 'OUTCOME_MISMATCH', run };
  return { valid: true, reason: 'RECOMPUTED_MATCH', run };
}

// ---------- Golden expectations ----------
export type GoldenResult = { readonly frameworkId: string; readonly checkpoint: string; readonly passed: boolean; readonly expected: string; readonly actual: string; readonly reasoning: string };
export function checkGolden(release: PackRelease, scenario: ScenarioSpec, runs: Readonly<Record<string, PackRun>>): GoldenResult[] {
  const results: GoldenResult[] = [];
  for (const [frameworkId, expectations] of Object.entries(scenario.expected)) {
    const run = runs[frameworkId];
    if (!run) throw Error('GOLDEN_RUN_MISSING');
    for (const x of expectations) {
      const point = run.checkpoints.find(c => c.semanticKey === x.checkpoint);
      const date = (tick: number | null | undefined) => tick === null || tick === undefined ? null : addDays(scenario.startDate, tick);
      const actual = point ? { present: true, dutyState: point.dutyState, eventDate: date(point.eventTick), dueDate: date(point.dueTick) } : { present: false };
      const want = { present: x.present, ...(x.dutyState !== undefined ? { dutyState: x.dutyState } : {}), ...(x.eventDate !== undefined ? { eventDate: x.eventDate } : {}), ...(x.dueDate !== undefined ? { dueDate: x.dueDate } : {}) };
      const got = Object.fromEntries(Object.keys(want).map(k => [k, (actual as Record<string, unknown>)[k] ?? null]));
      results.push({ frameworkId, checkpoint: x.checkpoint, passed: canonicalJSON(want) === canonicalJSON(got), expected: canonicalJSON(want), actual: canonicalJSON(got), reasoning: x.reasoning });
    }
  }
  for (const [frameworkId, values] of Object.entries(scenario.expectedFacts ?? {})) {
    const run = runs[frameworkId];
    if (!run) throw Error('GOLDEN_RUN_MISSING');
    for (const [factId, value] of Object.entries(values))
      results.push({ frameworkId, checkpoint: 'fact:' + factId, passed: run.facts[factId] === value, expected: canonicalJSON(value), actual: canonicalJSON(run.facts[factId] ?? null), reasoning: 'Independently computed end-of-run value' });
  }
  if (scenario.conservedAccounts?.length) {
    const start = scenario.conservedAccounts.reduce((n, a) => n + (scenario.facts[a] as number), 0);
    for (const [frameworkId, run] of Object.entries(runs)) {
      const end = scenario.conservedAccounts.reduce((n, a) => n + (run.facts[a] as number), 0);
      results.push({ frameworkId, checkpoint: 'conservation', passed: start === end, expected: String(start), actual: String(end), reasoning: 'Integer transfers move money between accounts without creating or losing any' });
    }
  }
  void release;
  return results;
}

// ---------- Framework comparison ----------
export type PackComparison = {
  readonly comparison: FrameworkComparison;
  readonly baseline: PackRun; readonly proposal: PackRun;
  readonly headline: readonly string[];
  readonly assumptionNotes: readonly { readonly semanticKey: string; readonly assumptionIds: readonly string[] }[];
};
export async function comparePack(release: PackRelease, manifestDigest: string, scenario: ScenarioSpec): Promise<PackComparison> {
  const baselineFw = release.frameworks.find(f => f.role === 'baseline');
  const proposalFw = release.frameworks.find(f => f.role === 'proposal');
  if (!baselineFw || !proposalFw) throw Error('COMPARISON_REQUIRES_BASELINE_AND_PROPOSAL');
  const calendar = release.calendars.find(c => c.id === scenario.calendarId)!;
  const framework = (f: typeof baselineFw) => ({
    id: f.id, versionId: f.versionId, status: f.status, modelDigest: manifestDigest, engineVersion: release.engineVersion.replace(/[^A-Za-z0-9._:-]/g, '-'),
    calendarVersion: calendar.version, baselineAsOf: baselineFw.asOf, jurisdiction: f.jurisdiction, agency: f.agency
  });
  const runs = new Map<string, PackRun>();
  // Behavior and operational inputs are identical: only the legal framework changes.
  const comparison = await compareFrameworks(framework(baselineFw), framework(proposalFw), {
    id: scenario.id, asOf: baselineFw.asOf, jurisdiction: baselineFw.jurisdiction, agency: baselineFw.agency, seed: scenario.seed,
    hypothetical: true, assumeProposalEnactment: scenario.enactment.assume,
    facts: { facts: scenario.facts, unknown: scenario.unknownFacts.map(u => u.factId), interpretations: scenario.interpretationChoices, events: scenario.events },
    implementation: { behaviors: scenario.behaviors, enactment: scenario.enactment, workload: scenario.workload ?? null }
  }, context => {
    const run = runPackScenario(release, context.framework.id, scenario);
    runs.set(context.framework.id, run);
    return { checkpoints: run.checkpoints, warnings: run.warnings.map(w => w.replace(/[^A-Za-z0-9._:-]/g, '-')) };
  });
  const baseline = runs.get(baselineFw.id)!, proposal = runs.get(proposalFw.id)!;
  const describe = (c: ComparisonChange) => {
    const label = c.semanticKey.replace(/-/g, ' ');
    if (c.kind === 'added') return 'Only under ' + proposalFw.label + ': ' + label + '.';
    if (c.kind === 'removed') return 'Only under ' + baselineFw.label + ': ' + label + '.';
    const parts: string[] = [];
    const a = c.baseline!, b = c.proposal!;
    if (c.reasons.includes('DUTY_STATE_CHANGED')) parts.push('duty ' + a.dutyState + ' → ' + b.dutyState);
    if (c.reasons.includes('TIMING_CHANGED')) {
      const d = (t: number | null) => t === null ? 'none' : addDays(scenario.startDate, t);
      if (a.eventTick !== b.eventTick) parts.push('date ' + d(a.eventTick) + ' → ' + d(b.eventTick));
      if (a.dueTick !== b.dueTick) parts.push('due ' + d(a.dueTick) + ' → ' + d(b.dueTick));
    }
    if (c.reasons.includes('LEGAL_FORCE_CHANGED')) parts.push('legal force ' + a.legalForce + ' → ' + b.legalForce);
    if (c.reasons.includes('UNCERTAINTY_CHANGED')) parts.push('uncertainty changed');
    if (c.reasons.includes('PROVENANCE_CHANGED') && parts.length === 0) parts.push('different source provisions');
    return label[0]!.toUpperCase() + label.slice(1) + ': ' + parts.join('; ') + '.';
  };
  const assumptionsFor = (run: PackRun, key: string) => [...new Set(run.events.filter(e => e.checkpoint === key).flatMap(e => e.assumptionIds))];
  const changed = comparison.changes.filter(c => c.kind !== 'unchanged');
  return {
    comparison, baseline, proposal,
    headline: changed.length ? changed.map(describe) : ['No modeled checkpoint differs between the two frameworks for these circumstances.'],
    assumptionNotes: changed.map(c => ({ semanticKey: c.semanticKey, assumptionIds: [...new Set([...assumptionsFor(baseline, c.semanticKey), ...assumptionsFor(proposal, c.semanticKey)])] })).filter(n => n.assumptionIds.length)
  };
}

// ---------- Explanation trace ----------
export type ExplainedEvent = {
  readonly event: PackEvent;
  readonly state: 'supported' | 'unresolved' | 'operational' | 'scenario';
  readonly plain: string; readonly detail: string;
  readonly causalChain: readonly string[];
  readonly excerpts: readonly { readonly citation: string; readonly quote: string; readonly text: string; readonly versionId: string; readonly sourceDigest: string; readonly documentTitle: string; readonly provisionId: string; readonly stale: boolean }[];
  readonly assumptions: readonly { readonly id: string; readonly label: string; readonly classification: string; readonly description: string }[];
  readonly exceptions: readonly { readonly id: string; readonly label: string }[];
};
export function resolveExcerpt(release: PackRelease, ref: SourceRef) {
  const doc = release.documents.find(d => d.versionId === ref.versionId);
  const provision = doc?.provisions.find(p => p.id === ref.provisionId);
  const stale = !doc || doc.sourceDigest !== ref.sourceDigest || !provision || !provision.text.includes(ref.quote);
  return { citation: provision?.citation ?? 'Unavailable provision', quote: ref.quote, text: provision?.text ?? '', versionId: ref.versionId, sourceDigest: ref.sourceDigest, documentTitle: doc?.title ?? 'Unavailable source', provisionId: ref.provisionId, stale };
}
export function explainEvent(release: PackRelease, run: PackRun, eventId: string): ExplainedEvent {
  const byId = new Map(run.events.map(e => [e.id, e]));
  const event = byId.get(eventId);
  if (!event) throw Error('EVENT_UNKNOWN');
  const chain: string[] = [];
  for (let cursor: PackEvent | undefined = event, guard = 0; cursor && guard < 10000; guard++) {
    chain.unshift(cursor.id);
    cursor = cursor.causeId ? byId.get(cursor.causeId) : undefined;
  }
  const framework = release.frameworks.find(f => f.id === run.frameworkId)!;
  const rule = event.ruleId ? framework.rules.find(r => r.id === event.ruleId) : undefined;
  const template = event.explanationKey ? release.explanations[event.explanationKey] : undefined;
  const unresolved = event.outcome === 'unknown' || event.unresolved.length > 0;
  const state: ExplainedEvent['state'] = unresolved ? 'unresolved' : event.basis === 'operational' ? 'operational' : event.basis === 'scenario' ? 'scenario' : 'supported';
  // Authored templates only; an unresolved outcome never receives confident prose.
  const plain = unresolved
    ? 'Unresolved in this model: ' + (event.unresolved.length ? event.unresolved.map(u => release.facts.find(f => f.id === u)?.label ?? u.replace(/_/g, ' ').toLowerCase()).join(', ') : 'the cited material does not settle this') + '. The result is not decided.'
    : event.category === 'not-effective' ? 'This provision would not yet operate on this date under the assumed enactment schedule.'
    : event.category === 'exception' ? 'An exception applied, so this rule did not take effect.'
    : event.basis === 'scenario' ? 'Scenario event: ' + event.label + '. This is a hypothetical starting fact, not a legal result.'
    : event.basis === 'operational' ? event.label + '. This timing comes from a labeled operational assumption, not from the law itself.'
    : template?.plain ?? rule?.effect.summary ?? event.label;
  const detail = unresolved ? (template?.detail ?? '') : event.basis === 'scenario' ? '' : template?.detail ?? '';
  const assumptions = event.assumptionIds.map(id => release.assumptions.find(a => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a)
    .map(a => ({ id: a.id, label: a.label, classification: a.classification, description: a.description }));
  const exceptions = event.appliedExceptions.map(id => ({ id, label: rule?.effect.exceptions?.find(x => x.id === id)?.label ?? id }));
  return { event, state, plain, detail, causalChain: chain, excerpts: event.sourceRefs.map(ref => resolveExcerpt(release, ref)), assumptions, exceptions };
}

// ---------- Stress testing and sensitivity (LM-037) ----------
export type StressRequest = {
  readonly frameworkId: string; readonly samples: number;
  readonly arrivalsPerDay: number; readonly workers: number; readonly unitsPerWorkerDay: number; readonly outageDays: readonly number[];
};
export type StressResult = {
  readonly samples: number; readonly action: string; readonly unit: 'business days late (0 = on time)';
  readonly satisfied: number; readonly breached: number; readonly neverPerformed: number;
  readonly histogram: readonly { readonly bucket: string; readonly count: number }[];
  readonly lateness: { readonly min: number | null; readonly median: number | null; readonly max: number | null };
  readonly legalDue: string | null;
  readonly assumptions: readonly string[];
  readonly methodology: string;
};
export const MAX_STRESS_SAMPLES = 400;
/**
 * Repeated seeded runs with a stochastic arrival model. Results describe the
 * variation produced by the stated assumptions only; they are not forecasts
 * or probabilities that a real agency meets a deadline.
 */
export async function stressScenario(release: PackRelease, manifestDigest: string, scenario: ScenarioSpec, request: StressRequest, signal?: { readonly cancelled: boolean }): Promise<StressResult> {
  const w = scenario.workload;
  if (!w) throw Error('STRESS_UNAVAILABLE_FOR_SCENARIO');
  const ints = [request.samples, request.arrivalsPerDay, request.workers, request.unitsPerWorkerDay];
  if (!ints.every(n => Number.isSafeInteger(n) && n >= 0) || request.samples < 1 || request.samples > MAX_STRESS_SAMPLES ||
      request.arrivalsPerDay > 500 || request.workers > 200 || request.unitsPerWorkerDay > 1000 ||
      !Array.isArray(request.outageDays) || request.outageDays.length > 60 || !request.outageDays.every(d => Number.isSafeInteger(d) && d >= 0 && d <= scenario.horizonDays))
    throw Error('STRESS_REQUEST_OUT_OF_BOUNDS');
  const calendar = legalCalendar(release, scenario.calendarId);
  const horizon = Math.min(scenario.horizonDays, 365);
  // Find when the focal duty arises with the declared default behavior.
  const probe = runPackScenario(release, request.frameworkId, scenario);
  const duty = probe.duties.find(d => d.action === w.action);
  if (!duty) throw Error('STRESS_DUTY_NOT_CREATED');
  const descriptor = replayDescriptor(manifestDigest, release, request.frameworkId, scenario);
  const stream = await namedStream(descriptor, 'stress-arrivals');
  const latenessValues: number[] = [];
  let satisfied = 0, breached = 0, never = 0;
  for (let sample = 0; sample < request.samples; sample++) {
    if (signal?.cancelled) throw Error('STRESS_CANCELLED');
    const items: WorkItem[] = [];
    // Backlog already waiting when the focal item arrives, then later arrivals.
    for (let day = 0; day <= duty.createdDay; day++) {
      const count = Math.floor(stream.nextUnit() * (2 * request.arrivalsPerDay + 1));
      for (let i = 0; i < count; i++) items.push({ id: 'bg-' + day + '-' + String(i).padStart(4, '0'), arrivedAt: day, units: w.unitsPerItem, legalDueTick: null, assumptionId: w.assumptionId });
    }
    items.push({ id: 'focal', arrivedAt: duty.createdDay, units: w.unitsPerItem, legalDueTick: duty.dueDay, assumptionId: w.assumptionId });
    const businessOutages = [...new Set([...request.outageDays, ...Array.from({ length: horizon + 1 }, (_, d) => d).filter(d => !isBusinessDay(calendar, addDays(scenario.startDate, d)))])];
    const result = processQueue(items, { workers: request.workers, unitsPerTick: request.unitsPerWorkerDay, sourceKind: w.sourceKind, sourceId: w.assumptionId }, horizon, { outageTicks: businessOutages });
    const record = result.records.find(r => r.itemId === 'focal');
    const run = runPackScenario(release, request.frameworkId, scenario, { performance: { [w.action]: record ? record.completedAt : null } });
    const focal = run.duties.find(d => d.action === w.action)!;
    if (!record || focal.performedDay === null) { never++; continue; }
    if (focal.state === 'satisfied') satisfied++; else if (focal.state === 'breached') breached++;
    if (focal.dueDay !== null) {
      let late = 0;
      for (let d = focal.dueDay + 1; d <= focal.performedDay; d++) if (isBusinessDay(calendar, addDays(scenario.startDate, d))) late++;
      latenessValues.push(late);
    }
  }
  latenessValues.sort((a, b) => a - b);
  const buckets = new Map<string, number>([['On time', 0], ['1–2 days late', 0], ['3–5 days late', 0], ['6–10 days late', 0], ['More than 10 days late', 0]]);
  for (const v of latenessValues) {
    const key = v === 0 ? 'On time' : v <= 2 ? '1–2 days late' : v <= 5 ? '3–5 days late' : v <= 10 ? '6–10 days late' : 'More than 10 days late';
    buckets.set(key, buckets.get(key)! + 1);
  }
  if (never) buckets.set('Not performed within horizon', never);
  const at = (q: number) => latenessValues.length ? latenessValues[Math.min(latenessValues.length - 1, Math.floor(q * latenessValues.length))]! : null;
  const assumption = release.assumptions.find(a => a.id === w.assumptionId);
  return {
    samples: request.samples, action: w.action, unit: 'business days late (0 = on time)', satisfied, breached, neverPerformed: never,
    histogram: [...buckets].map(([bucket, count]) => ({ bucket, count })),
    lateness: { min: latenessValues[0] ?? null, median: at(0.5), max: latenessValues.at(-1) ?? null },
    legalDue: duty.dueDate, assumptions: [assumption ? assumption.label + ' (' + assumption.classification + ')' : w.assumptionId, 'Daily arrivals uniformly drawn from 0 to ' + 2 * request.arrivalsPerDay + ' (mean ' + request.arrivalsPerDay + ')', 'Work proceeds only on business days; ' + request.outageDays.length + ' outage day(s)'],
    methodology: request.samples + ' seeded runs of the same legal model. Only the operational queue varies; every run keeps the same legal duty and due date (' + (duty.dueDate ?? 'unresolved') + '). Counts show how often the modeled queue finishes on time under these illustrative assumptions. They are not a prediction for any real agency and no probability claim is made.'
  };
}
export const daysBetween = diffDays;
