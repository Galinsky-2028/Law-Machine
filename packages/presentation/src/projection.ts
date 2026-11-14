import type { FocusTarget, PackRelease, ScenarioSpec } from '../../contracts/src/pack.ts';
import type { PackEvent, PackRun } from '../../simulation/src/pack-engine.ts';

/**
 * LM-032..LM-034: renderer-side projections of an executed trace. Every
 * function here reads a finished run; none can add, remove or reorder legal
 * events. Moving a node changes coordinates only.
 */
export type NodeState = {
  readonly actorId: string; readonly name: string; readonly kind: string; readonly icon: string;
  readonly x: number; readonly y: number; readonly group: string | null;
  readonly active: boolean; readonly holdsObject: boolean;
  readonly pendingDuties: number; readonly breachedDuties: number; readonly satisfiedDuties: number;
};
export type EdgeState = { readonly id: string; readonly from: string; readonly to: string; readonly kind: 'route' | 'authority'; readonly label: string; readonly active: boolean; readonly travelled: boolean };
export type DutyView = { readonly id: string; readonly action: string; readonly actorId: string; readonly label: string; readonly state: 'pending' | 'satisfied' | 'breached' | 'unknown' | 'not-yet'; readonly dueDate: string | null; readonly performedDate: string | null; readonly ruleId: string };
export type PlaybackState = {
  readonly step: number; readonly total: number;
  readonly event: PackEvent | null; readonly date: string | null; readonly day: number;
  readonly nodes: readonly NodeState[]; readonly edges: readonly EdgeState[];
  readonly duties: readonly DutyView[];
  readonly objectAt: string | null;
  readonly announcement: string;
};

const EVENT_PRIORITY: Record<PackEvent['category'], number> = { external: 0, arrival: 1, rule: 2, duty: 2, clock: 2, performance: 3, breach: 3, exception: 4, 'not-effective': 4, unresolved: 4 };
export function visibleEvents(run: PackRun): readonly PackEvent[] { return run.events; }

/** Reconstruct the scene exactly as of `step` (0 = before any event). Scrubbing is a pure function. */
export function playbackState(release: PackRelease, run: PackRun, step: number): PlaybackState {
  const total = run.events.length;
  const at = Math.max(0, Math.min(total, Math.floor(step)));
  const seen = run.events.slice(0, at);
  const current = at > 0 ? run.events[at - 1]! : null;
  const scene = release.scene;
  let objectAt: string | null = null;
  const travelled = new Set<string>();
  for (const e of seen) {
    const edge = scene.edges.find(x => x.kind === 'route' && x.eventKinds.includes(e.kind) && (x.from === e.actorId || x.to === e.actorId || e.category === 'external'));
    if (edge) { travelled.add(edge.id); objectAt = edge.to; }
    else if (e.category === 'external' || e.category === 'arrival') objectAt = e.actorId;
  }
  const dutyState = new Map<string, DutyView>();
  for (const e of seen) {
    if (!e.dutyId) continue;
    const record = run.duties.find(d => d.id === e.dutyId)!;
    const state: DutyView['state'] = e.category === 'duty' ? (record.state === 'unknown' ? 'unknown' : 'pending') : e.category === 'breach' ? 'breached' : e.category === 'performance' ? (e.outcome === 'breached' ? 'breached' : e.outcome === 'satisfied' ? 'satisfied' : 'unknown') : dutyState.get(record.id)?.state ?? 'pending';
    const rule = release.frameworks.find(f => f.id === run.frameworkId)!.rules.find(r => r.id === record.ruleId);
    dutyState.set(record.id, { id: record.id, action: record.action, actorId: record.actorId, label: rule?.effect.summary ?? record.action, state, dueDate: record.dueDate,
      performedDate: e.category === 'performance' ? record.performedDate : dutyState.get(record.id)?.performedDate ?? null, ruleId: record.ruleId });
  }
  const duties = run.duties.map(d => dutyState.get(d.id) ?? { id: d.id, action: d.action, actorId: d.actorId, label: d.action, state: 'not-yet' as const, dueDate: d.dueDate, performedDate: null, ruleId: d.ruleId });
  const actors = new Map(release.actors.map(a => [a.id, a]));
  const nodes = scene.nodes.map(n => {
    const mine = duties.filter(d => d.actorId === n.actorId);
    return { actorId: n.actorId, name: actors.get(n.actorId)?.name ?? n.actorId, kind: actors.get(n.actorId)?.kind ?? 'other', icon: n.icon, x: n.x, y: n.y, group: n.group ?? null,
      active: current?.actorId === n.actorId, holdsObject: objectAt === n.actorId,
      pendingDuties: mine.filter(d => d.state === 'pending').length, breachedDuties: mine.filter(d => d.state === 'breached').length, satisfiedDuties: mine.filter(d => d.state === 'satisfied').length };
  });
  const edges = scene.edges.map(e => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, label: e.label,
    active: !!current && e.eventKinds.includes(current.kind) && (e.from === current.actorId || e.to === current.actorId || current.category === 'external'), travelled: travelled.has(e.id) }));
  const base = current ? current.date + ': ' + current.label.replace(/[.\s]+$/, '') : '';
  const announcement = current ? base + (current.outcome === 'breached' ? ' — duty breached.' : current.outcome === 'unknown' ? ' — unresolved.' : current.category === 'not-effective' ? ' — not yet in effect.' : '.') : 'Before the scenario starts.';
  return { step: at, total, event: current, date: current?.date ?? null, day: current?.day ?? 0, nodes, edges, duties, objectAt, announcement };
}

/** Stops at each new date or each legally significant event, never at internal bookkeeping only. */
export function checkpointSteps(run: PackRun): number[] {
  const steps: number[] = [];
  run.events.forEach((e, i) => { if (EVENT_PRIORITY[e.category] !== 2 || e.checkpoint || e.outcome === 'breached' || e.outcome === 'unknown') steps.push(i + 1); });
  return steps;
}

export type SequenceDay = { readonly date: string; readonly day: number; readonly items: readonly { readonly step: number; readonly event: PackEvent; readonly actorName: string }[] };
/** The accessible sequence view: the same trace, grouped by simulated date. */
export function sequenceView(release: PackRelease, run: PackRun): readonly SequenceDay[] {
  const names = new Map(release.actors.map(a => [a.id, a.name]));
  const days: SequenceDay[] = [];
  run.events.forEach((event, i) => {
    let last = days.at(-1);
    if (!last || last.date !== event.date) { last = { date: event.date, day: event.day, items: [] }; days.push(last); }
    (last.items as { step: number; event: PackEvent; actorName: string }[]).push({ step: i + 1, event, actorName: names.get(event.actorId) ?? event.actorId });
  });
  return days;
}

export type ResolvedFocus = { readonly target: FocusTarget; readonly label: string; readonly actorIds: readonly string[]; readonly eventIds: readonly string[]; readonly provision: { readonly versionId: string; readonly id: string; readonly citation: string; readonly text: string } | null; readonly found: boolean };
/** Stable semantic focus targets shared by the renderer, the guided tour and SDK consumers. */
export function resolveFocus(release: PackRelease, run: PackRun | null, target: FocusTarget): ResolvedFocus {
  const none = (label: string): ResolvedFocus => ({ target, label, actorIds: [], eventIds: [], provision: null, found: false });
  if (target.kind === 'actor') {
    const actor = release.actors.find(a => a.id === target.id);
    if (!actor) return none('Unknown actor');
    return { target, label: actor.name, actorIds: [actor.id], eventIds: run?.events.filter(e => e.actorId === actor.id).map(e => e.id) ?? [], provision: null, found: true };
  }
  if (target.kind === 'provision') {
    const doc = release.documents.find(d => d.versionId === target.versionId);
    const p = doc?.provisions.find(x => x.id === target.id);
    if (!doc || !p) return none('Unknown provision');
    return { target, label: p.citation + ' — ' + doc.title, actorIds: [], eventIds: run?.events.filter(e => e.sourceRefs.some(r => r.provisionId === p.id && r.versionId === p.versionId)).map(e => e.id) ?? [], provision: { versionId: p.versionId, id: p.id, citation: p.citation, text: p.text }, found: true };
  }
  if (target.kind === 'rule') {
    const rule = release.frameworks.find(f => f.id === target.frameworkId)?.rules.find(r => r.id === target.id);
    if (!rule) return none('Unknown rule');
    return { target, label: rule.effect.summary, actorIds: [rule.actorId], eventIds: run?.frameworkId === target.frameworkId ? run.events.filter(e => e.ruleId === rule.id).map(e => e.id) : [], provision: null, found: true };
  }
  if (target.kind === 'checkpoint') {
    const events = run?.events.filter(e => e.checkpoint === target.id) ?? [];
    return { target, label: target.id.replace(/-/g, ' '), actorIds: [...new Set(events.map(e => e.actorId))], eventIds: events.map(e => e.id), provision: null, found: events.length > 0 };
  }
  const event = run?.events.find(e => e.id === target.id);
  return event ? { target, label: event.label, actorIds: [event.actorId], eventIds: [event.id], provision: null, found: true } : none('Unknown event');
}

// ---------- Search (LM-040) ----------
export type SearchDoc = { readonly id: string; readonly packId: string; readonly kind: 'glossary' | 'provision' | 'scenario' | 'rule'; readonly title: string; readonly text: string; readonly href: string; readonly status: string; readonly source: string | null; readonly keywords: readonly string[] };
const tokenize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9§ ]+/g, ' ').split(/\s+/).filter(t => t.length > 1);
const STOP = new Set(['the', 'of', 'and', 'or', 'to', 'a', 'an', 'is', 'in', 'by', 'for', 'be', 'it', 'on', 'at', 'as', 'that', 'this', 'what', 'when', 'how', 'does', 'do', 'with']);
/** Index only published release content. Draft or private records never enter this function. */
export function buildSearchDocs(release: PackRelease, base: string): SearchDoc[] {
  const status = (release.fictional ? 'Fictional · ' : '') + release.title;
  const docs: SearchDoc[] = [];
  for (const g of release.glossary) docs.push({ id: 'g:' + g.id, packId: release.packId, kind: 'glossary', title: g.term, text: g.plain + ' ' + g.detail, href: base + '/glossary#' + g.id, status, source: g.sourceRefs[0] ? release.documents.find(d => d.versionId === g.sourceRefs[0]!.versionId)?.provisions.find(p => p.id === g.sourceRefs[0]!.provisionId)?.citation ?? null : null, keywords: [g.term, ...g.aliases] });
  for (const s of release.scenarios) docs.push({ id: 's:' + s.id, packId: release.packId, kind: 'scenario', title: s.title, text: s.question + ' ' + s.summary, href: base + '/scenarios/' + s.id, status, source: null, keywords: [] });
  for (const d of release.documents) for (const p of d.provisions) docs.push({ id: 'p:' + d.versionId + ':' + p.id, packId: release.packId, kind: 'provision', title: p.citation + ' · ' + d.title, text: p.text, href: base + '/sources/' + d.sourceId + '#' + p.id, status: d.title, source: p.citation, keywords: [] });
  for (const f of release.frameworks) for (const r of f.rules) docs.push({ id: 'r:' + f.id + ':' + r.id, packId: release.packId, kind: 'rule', title: r.effect.summary, text: (release.explanations[r.explanationKey]?.plain ?? '') + ' ' + (release.explanations[r.explanationKey]?.detail ?? ''), href: base + '/sources/' + f.sourceId + '#' + (r.sourceRefs[0]?.provisionId ?? ''), status: f.label, source: release.documents.find(d => d.versionId === f.versionId)?.provisions.find(p => p.id === r.sourceRefs[0]?.provisionId)?.citation ?? null, keywords: [] });
  return docs;
}
export type SearchHit = SearchDoc & { readonly score: number };
export function search(docs: readonly SearchDoc[], query: string, limit = 20): SearchHit[] {
  if (typeof query !== 'string' || query.length > 200) return [];
  const terms = tokenize(query).filter(t => !STOP.has(t));
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    const title = tokenize(d.title), body = tokenize(d.text), keys = d.keywords.flatMap(tokenize);
    let score = 0;
    for (const t of terms) {
      const stem = t.replace(/(ing|ed|es|s)$/, '');
      const match = (w: string) => w === t || (stem.length > 3 && w.startsWith(stem));
      if (keys.some(match)) score += 6;
      if (title.some(match)) score += 4;
      score += Math.min(3, body.filter(match).length);
    }
    if (score > 0) hits.push({ ...d, score: score + (d.kind === 'glossary' ? 1 : 0) });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

// ---------- Share links (LM-039) ----------
export type ShareState = { readonly packId: string; readonly release: string; readonly scenarioId: string; readonly framework: string; readonly step: number | null; readonly params: Readonly<Record<string, boolean | number | string | null>> };
/** Only allowlisted structured values; free text never enters a URL. */
export function encodeShare(scenario: ScenarioSpec, state: ShareState): string {
  const q = new URLSearchParams();
  q.set('r', state.release);
  q.set('f', state.framework);
  if (state.step !== null) q.set('step', String(state.step));
  for (const p of scenario.parameters) {
    if (!Object.hasOwn(state.params, p.id)) continue;
    const v = state.params[p.id];
    q.set('p.' + p.id, v === null ? '~' : String(v));
  }
  return q.toString();
}
export function decodeShare(scenario: ScenarioSpec, query: string): { readonly release: string | null; readonly framework: string | null; readonly step: number | null; readonly params: Record<string, boolean | number | string | null>; readonly rejected: readonly string[] } {
  const q = new URLSearchParams(query.length > 4000 ? '' : query);
  const params: Record<string, boolean | number | string | null> = {};
  const rejected: string[] = [];
  for (const [key, raw] of q) {
    if (!key.startsWith('p.')) continue;
    const p = scenario.parameters.find(x => x.id === key.slice(2));
    if (!p || raw.length > 40) { rejected.push(key); continue; }
    if (p.control === 'integer') { const n = Number(raw); if (/^-?\d+$/.test(raw) && Number.isSafeInteger(n)) params[p.id] = n; else rejected.push(key); }
    else if (p.control === 'boolean' || p.control === 'tristate') { if (raw === 'true' || raw === 'false') params[p.id] = raw === 'true'; else if (raw === '~' && p.control === 'tristate') params[p.id] = null; else rejected.push(key); }
    else if (p.options?.some(o => o.value === raw)) params[p.id] = raw; else rejected.push(key);
  }
  const release = q.get('r'), framework = q.get('f'), step = q.get('step');
  return { release: release && /^[a-f0-9]{64}$/.test(release) ? release : null, framework: framework && /^[a-z0-9-]{1,40}$/.test(framework) ? framework : null,
    step: step && /^\d{1,5}$/.test(step) ? Number(step) : null, params, rejected };
}
