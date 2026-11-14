import { canonicalDigest, canonicalJSON, sha256Hex, type ReleaseManifest } from '../../contracts/src/integrity.ts';
import type { ModelBundle, SourceRef } from '../../contracts/src/model.ts';
import {
  PACK_CAPABILITIES, PACK_ENGINE_VERSION, PACK_FORMAT,
  type AuthoredPack, type AuthoredRef, type CoverageReport, type DeadlineSpec, type EffectBinding,
  type PackDocument, type PackFramework, type PackProvision, type PackRelease, type PackRule
} from '../../contracts/src/pack.ts';
import { validateBundle } from '../../contracts/src/validate.ts';
import { compileRuleModel } from '../../rules/src/compiler.ts';
import { assessCoverage } from './coverage.ts';
import { importText } from './import-text.ts';
import { normalizeSource } from './provision-tree.ts';

/**
 * LM-047 release assembly. Turns an authored pack plus preserved source bytes
 * into an immutable, content-addressed release. Every reference is resolved
 * against the exact bytes supplied here; a quote that does not occur verbatim
 * fails the build instead of being repaired.
 */
export type PackManifest = ReleaseManifest & {
  readonly format: typeof PACK_FORMAT;
  readonly packId: string;
  readonly label: string;
  readonly engineVersion: typeof PACK_ENGINE_VERSION;
  readonly bundlePath: string;
};
export type BuildDiagnostic = { readonly code: string; readonly path: string; readonly message: string };
export type BuiltPack = {
  readonly valid: boolean;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly release: PackRelease | null;
  readonly manifest: PackManifest | null;
  readonly manifestDigest: string | null;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly primarySourceBytes: Uint8Array | null;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const text = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';

/** Stable, human-meaningful provision identity derived from displayed numbering. */
export function provisionPaths(provisions: readonly { id: string; parentId: string | null; citation: string | null; span: { start: number } }[]): Map<string, { path: string; citation: string }> {
  const byId = new Map(provisions.map(p => [p.id, p]));
  const out = new Map<string, { path: string; citation: string }>();
  const used = new Set<string>();
  const resolve = (pid: string, depth: number): { path: string; citation: string } => {
    const cached = out.get(pid);
    if (cached) return cached;
    const p = byId.get(pid)!;
    const label = (p.citation ?? '').trim();
    let value: { path: string; citation: string };
    if (p.parentId !== null && byId.has(p.parentId) && depth < 20) {
      const parent = resolve(p.parentId, depth + 1);
      value = { path: parent.path + '(' + label + ')', citation: parent.citation + '(' + label + ')' };
    } else if (/^[0-9]+(?:\.[0-9]+)*[A-Za-z]?$/.test(label)) value = { path: label, citation: '§ ' + label };
    else value = { path: 'h-' + slug(label), citation: label || 'Unnumbered text' };
    if (used.has(value.path)) value = { path: value.path + '-L' + p.span.start, citation: value.citation };
    used.add(value.path);
    out.set(pid, value);
    return value;
  };
  for (const p of provisions) resolve(p.id, 0);
  return out;
}
const provisionId = (path: string) => 's' + path.replace(/\(/g, '.').replace(/\)/g, '').replace(/[^A-Za-z0-9._-]/g, '-');

export async function buildPackRelease(input: unknown, sourceBytes: ReadonlyMap<string, Uint8Array>): Promise<BuiltPack> {
  const diagnostics: BuildDiagnostic[] = [];
  const fail = (code: string, path: string, message: string) => { if (diagnostics.length < 200) diagnostics.push({ code, path, message }); };
  const failure = (): BuiltPack => ({ valid: false, diagnostics, release: null, manifest: null, manifestDigest: null, assets: new Map(), primarySourceBytes: null });
  const pack = input as AuthoredPack;
  if (!pack || typeof pack !== 'object' || Array.isArray(pack) || pack.format !== PACK_FORMAT || !id(pack.packId) ||
      !text(pack.title, 200) || !text(pack.question, 300) || !text(pack.summary, 2000) || !id(pack.domain) ||
      typeof pack.fictional !== 'boolean' || !text(pack.releaseLabel, 60) || !date(pack.releasedAt) ||
      !list(pack.disclaimers, 20) || !pack.disclaimers.every(d => text(d, 600)) ||
      !list(pack.sources, 32) || !pack.sources.length || !list(pack.actors, 200) || !list(pack.facts, 500) ||
      !list(pack.calendars, 16) || !list(pack.deadlines, 200) || !list(pack.frameworks, 8) || !pack.frameworks.length ||
      !list(pack.interpretations, 50) || !list(pack.assumptions, 500) || !list(pack.scenarios, 64) ||
      !list(pack.glossary, 500) || !pack.scene || typeof pack.scene !== 'object' ||
      !pack.explanations || typeof pack.explanations !== 'object' || !pack.eventLabels || typeof pack.eventLabels !== 'object') {
    fail('PACK_SHAPE_INVALID', '$', 'Pack does not match ' + PACK_FORMAT);
    return failure();
  }
  if (!(sourceBytes instanceof Map)) { fail('SOURCE_BYTES_MISSING', '$.sources', 'Original source bytes are required'); return failure(); }
  const unique = (items: readonly { id: string }[], path: string) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (!item || !id(item.id)) fail('ID_INVALID', path + '[' + i + ']', 'Invalid identifier');
      else if (seen.has(item.id)) fail('ID_DUPLICATE', path + '[' + i + ']', 'Duplicate identifier ' + item.id);
      else seen.add(item.id);
    });
    return seen;
  };
  const sourceIds = unique(pack.sources, '$.sources');
  const actorIds = unique(pack.actors, '$.actors');
  const factIds = unique(pack.facts, '$.facts');
  const calendarIds = unique(pack.calendars, '$.calendars');
  const deadlineIds = unique(pack.deadlines, '$.deadlines');
  const frameworkIds = unique(pack.frameworks, '$.frameworks');
  const interpretationIds = unique(pack.interpretations, '$.interpretations');
  const assumptionIds = unique(pack.assumptions, '$.assumptions');
  unique(pack.scenarios, '$.scenarios');
  unique(pack.glossary, '$.glossary');
  if (diagnostics.length) return failure();

  if (pack.fictional) {
    if (pack.sources.some(s => s.kind !== 'fictional')) fail('FICTIONAL_SOURCE_KIND', '$.sources', 'A fictional pack may contain only invented sources');
    if (!pack.disclaimers.length) fail('FICTIONAL_DISCLAIMER_MISSING', '$.disclaimers', 'A fictional pack must say that its law is invented');
  } else {
    for (const [i, s] of pack.sources.entries()) {
      if (s.kind === 'fictional') fail('REAL_PACK_FICTIONAL_SOURCE', '$.sources[' + i + ']', 'A non-fictional pack cannot include invented law');
      if (!text(s.origin, 500) || typeof s.retrievedAt !== 'string' || !Number.isFinite(Date.parse(s.retrievedAt)))
        fail('SOURCE_RETRIEVAL_UNRECORDED', '$.sources[' + i + ']', 'Real sources need an origin and retrieval time');
      if (s.kind === 'baseline' && !(typeof s.officialUrl === 'string' && /^https:\/\//.test(s.officialUrl)))
        fail('BASELINE_OFFICIAL_URL_MISSING', '$.sources[' + i + ']', 'Current-law sources must cite dated official material');
    }
  }

  // Preserve bytes, parse the tree and assign version-scoped provision identities.
  const frameworkBySource = new Map<string, PackFramework<AuthoredRef>>();
  for (const f of pack.frameworks) {
    if (!sourceIds.has(f.sourceId)) fail('FRAMEWORK_SOURCE_UNKNOWN', '$.frameworks.' + f.id, 'Unknown source ' + f.sourceId);
    else if (frameworkBySource.has(f.sourceId)) fail('FRAMEWORK_SOURCE_SHARED', '$.frameworks.' + f.id, 'Each framework pins its own source version');
    else frameworkBySource.set(f.sourceId, f);
  }
  const documents: PackDocument[] = [];
  const assets = new Map<string, Uint8Array>();
  const byPath = new Map<string, Map<string, PackProvision>>();
  for (const [i, s] of pack.sources.entries()) {
    const path = '$.sources[' + i + ']';
    const bytes = sourceBytes.get(s.id);
    if (!text(s.title, 300) || !['bill', 'baseline', 'fictional'].includes(s.kind) || !['text', 'markdown'].includes(s.format) ||
        !text(s.file, 200) || !text(s.rights, 500) || !(bytes instanceof Uint8Array)) {
      fail('SOURCE_INVALID', path, 'Source metadata or original bytes missing'); continue;
    }
    const versionId = frameworkBySource.get(s.id)?.versionId ?? 'src-' + s.id;
    if (!id(versionId)) { fail('VERSION_INVALID', path, 'Invalid version identifier'); continue; }
    let normalized;
    try { normalized = normalizeSource(versionId, await importText(bytes, { format: s.format, name: s.file.split('/').pop()! })); }
    catch (error) { fail('SOURCE_IMPORT_FAILED', path, error instanceof Error ? error.message : 'import failed'); continue; }
    for (const d of normalized.diagnostics)
      if (['MISSING_PARENT', 'PARENT_CYCLE', 'DUPLICATE_PROVISION_ID', 'NO_STRUCTURAL_NUMBERING'].includes(d.code)) fail('SOURCE_STRUCTURE_' + d.code, path, 'Source structure cannot be published');
    const paths = provisionPaths(normalized.provisions);
    const provisions: PackProvision[] = normalized.provisions.map(p => {
      const located = paths.get(p.id)!;
      return { id: provisionId(located.path), versionId, parentId: p.parentId === null ? null : provisionId(paths.get(p.parentId)!.path),
        path: located.path, citation: located.citation, text: p.text, span: p.span };
    });
    const index = new Map<string, PackProvision>();
    for (const p of provisions) {
      if (/-L\d+$/.test(p.path)) fail('PROVISION_PATH_DUPLICATE', path, 'Displayed numbering repeats: ' + p.path);
      if (p.text.length > 8192) fail('PROVISION_TOO_LONG', path, 'Provision ' + p.path + ' exceeds the public excerpt limit');
      index.set(p.path, p);
    }
    byPath.set(s.id, index);
    const assetPath = 'assets/' + normalized.sourceDigest + '.' + (s.format === 'markdown' ? 'md' : 'txt');
    assets.set(assetPath, bytes.slice());
    documents.push({ sourceId: s.id, versionId, sourceDigest: normalized.sourceDigest, title: s.title, kind: s.kind, format: s.format,
      origin: s.origin, retrievedAt: s.retrievedAt, rights: s.rights, officialUrl: s.officialUrl ?? null, assetPath, provisions });
  }
  if (diagnostics.length) return failure();
  const documentBySource = new Map(documents.map(d => [d.sourceId, d]));
  const defaultSource = (pack.frameworks.find(f => f.role === 'proposal') ?? pack.frameworks[0]!).sourceId;
  const pin = (ref: AuthoredRef & { source?: string }, path: string, fallbackSource: string): SourceRef | null => {
    const source = ref && typeof ref.source === 'string' ? ref.source : fallbackSource;
    const doc = documentBySource.get(source);
    const provision = doc && ref && typeof ref.provision === 'string' ? byPath.get(source)!.get(ref.provision) : undefined;
    if (!doc || !provision) { fail('REF_PROVISION_NOT_FOUND', path, 'No provision ' + String(ref?.provision) + ' in source ' + source); return null; }
    if (typeof ref.quote !== 'string' || !ref.quote.trim() || ref.quote.length > 2000 || !provision.text.includes(ref.quote)) {
      fail('REF_QUOTE_NOT_FOUND', path, 'Exact quote does not occur in ' + provision.citation); return null;
    }
    return { versionId: doc.versionId, provisionId: provision.id, sourceDigest: doc.sourceDigest, quote: ref.quote };
  };
  const pinAll = (refs: readonly AuthoredRef[] | undefined, path: string, source: string, min = 1): SourceRef[] => {
    if (!Array.isArray(refs) || refs.length < min || refs.length > 50) { fail('REFS_REQUIRED', path, 'Provenance is required'); return []; }
    return refs.map((r, i) => pin(r, path + '[' + i + ']', source)).filter((r): r is SourceRef => r !== null);
  };

  for (const [i, a] of pack.actors.entries())
    if (!text(a.name, 120) || !text(a.description, 1000) || !['agency', 'court', 'person', 'organization', 'other'].includes(a.kind)) fail('ACTOR_INVALID', '$.actors[' + i + ']', 'Invalid actor');
  for (const [i, f] of pack.facts.entries())
    if (!['boolean', 'number', 'string'].includes(f.type) || !text(f.label, 200) || !text(f.description, 1000) || f.id.startsWith('interp.')) fail('FACT_INVALID', '$.facts[' + i + ']', 'Invalid fact declaration');
  for (const [i, c] of pack.calendars.entries())
    if (!id(c.version) || !text(c.timeZone, 100) || !text(c.basis, 1000) || !Array.isArray(c.weekendDays) || !Array.isArray(c.observedHolidays) || !c.observedHolidays.every(date)) fail('CALENDAR_INVALID', '$.calendars[' + i + ']', 'Invalid calendar');
  for (const [i, a] of pack.assumptions.entries())
    if (!text(a.label, 200) || !text(a.description, 2000) || !['interpretation', 'empirical', 'hypothetical', 'unknown'].includes(a.classification) || !list(a.limitations, 20)) fail('ASSUMPTION_INVALID', '$.assumptions[' + i + ']', 'Invalid assumption');

  const deadlines: DeadlineSpec<SourceRef>[] = pack.deadlines.map((d, i) => {
    const path = '$.deadlines[' + i + ']';
    if (!text(d.label, 200) || !calendarIds.has(d.calendarId) || !Number.isSafeInteger(d.amount) || d.amount < 1 || d.amount > 5000 ||
        !['calendar-day', 'business-day', 'calendar-month'].includes(d.unit) || !['exclude-trigger', 'include-trigger'].includes(d.startCounting) ||
        !['clamp', 'unresolved'].includes(d.monthEnd) || !['extend', 'keep', 'unresolved'].includes(d.nonBusinessDue) ||
        (d.interpretationId !== undefined && !interpretationIds.has(d.interpretationId) && !assumptionIds.has(d.interpretationId)))
      fail('DEADLINE_INVALID', path, 'Every deadline needs explicit calendar semantics');
    return { ...d, sourceRefs: pinAll(d.sourceRefs, path + '.sourceRefs', defaultSource) };
  });

  const interpretations = pack.interpretations.map((c, i) => {
    const path = '$.interpretations[' + i + ']';
    if (!text(c.question, 600) || !list(c.alternatives, 8) || c.alternatives.length < 2) fail('INTERPRETATION_INVALID', path, 'A conflict needs a question and at least two alternatives');
    const alternativeIds = new Set((c.alternatives ?? []).map(a => a.id));
    if (alternativeIds.size !== (c.alternatives ?? []).length) fail('INTERPRETATION_INVALID', path, 'Duplicate alternative');
    if (c.chosen && (!alternativeIds.has(c.chosen.alternativeId) || !id(c.chosen.reviewerId) || !text(c.chosen.rationale, 2000)))
      fail('INTERPRETATION_CHOICE_UNREVIEWED', path, 'A selected reading needs a reviewer and rationale');
    return { ...c, alternatives: (c.alternatives ?? []).map((a, j) => {
      if (!id(a.id) || !text(a.label, 200) || !text(a.description, 2000) || !frameworkIds.has(a.frameworkId)) fail('INTERPRETATION_INVALID', path + '.alternatives[' + j + ']', 'Invalid alternative');
      return { ...a, sourceRefs: pinAll(a.sourceRefs, path + '.alternatives[' + j + '].sourceRefs', pack.frameworks.find(f => f.id === a.frameworkId)?.sourceId ?? defaultSource) };
    }) };
  });

  const factTypes: Record<string, 'boolean' | 'number' | 'string'> = Object.fromEntries(pack.facts.map(f => [f.id, f.type]));
  for (const c of pack.interpretations) factTypes['interp.' + c.id] = 'string';
  const scripted = new Set(pack.scenarios.flatMap(s => Array.isArray(s.events) ? s.events.map(e => e.kind) : []));
  const frameworks: PackRelease['frameworks'][number][] = [];
  const coverage: CoverageReport[] = [];
  for (const [fi, f] of pack.frameworks.entries()) {
    const path = '$.frameworks[' + fi + ']';
    const doc = documentBySource.get(f.sourceId)!;
    if (!text(f.label, 200) || !['baseline', 'proposal'].includes(f.role) || !id(f.billId) || !text(f.version, 100) || !id(f.versionId) ||
        !['draft', 'introduced', 'enacted', 'repealed'].includes(f.status) || !id(f.jurisdiction) || !id(f.agency) || !date(f.asOf) ||
        !list(f.rules, 256) || !list(f.coverage, 10000) || !list(f.gaps, 100) || !f.gaps.every(g => text(g, 1000))) {
      fail('FRAMEWORK_INVALID', path, 'Invalid framework metadata'); continue;
    }
    if (f.role === 'baseline' && f.status !== 'enacted') fail('BASELINE_NOT_ENACTED', path, 'A baseline models law recorded as in force on its date');
    if (f.role === 'proposal' && f.status === 'repealed') fail('PROPOSAL_STATUS_INVALID', path, 'A repealed text cannot be a proposal');
    const emitted = (e: EffectBinding<AuthoredRef>): string[] => e.kind === 'create-obligation' ? [e.onPerformEmits, ...(e.onBreachEmits ? [e.onBreachEmits] : [])] : e.emits ? [e.emits] : [];
    // Reachability is a fixpoint from scripted scenario events through declared effects.
    const reachable = new Set(scripted);
    for (let changed = true; changed;) {
      changed = false;
      for (const r of f.rules) if (r && r.effect && reachable.has(r.trigger)) for (const kind of emitted(r.effect)) if (!reachable.has(kind)) { reachable.add(kind); changed = true; }
    }
    const rules: PackRule<SourceRef>[] = [];
    for (const [ri, r] of f.rules.entries()) {
      const rpath = path + '.rules[' + ri + ']';
      const e = r?.effect;
      if (!r || !id(r.id) || !id(r.trigger) || !e || typeof e !== 'object' || e.kind !== r.operation || !text(e.summary, 600) ||
          (e.checkpoint !== undefined && !id(e.checkpoint)) || !Array.isArray(r.exceptions) ||
          (r.exceptions.length > 0 && (!Array.isArray(e.exceptions) || e.exceptions.length !== r.exceptions.length)) ||
          (e.effectiveAfterEnactmentDays !== undefined && (f.role !== 'proposal' || !Number.isSafeInteger(e.effectiveAfterEnactmentDays) || e.effectiveAfterEnactmentDays < 0 || e.effectiveAfterEnactmentDays > 3650))) {
        fail('RULE_BINDING_INVALID', rpath, 'Effect must match the rule operation and label each exception'); continue;
      }
      if (e.kind === 'create-obligation' && (!id(e.action) || !id(e.onPerformEmits) || (e.onBreachEmits !== undefined && !id(e.onBreachEmits)) || !(e.deadlineId === null || deadlineIds.has(e.deadlineId)))) fail('EFFECT_INVALID', rpath, 'Invalid obligation effect');
      if (e.kind === 'route' && (!actorIds.has(e.to) || !id(e.emits) || (e.transitAction !== undefined && !id(e.transitAction)))) fail('EFFECT_INVALID', rpath, 'Invalid route effect');
      if (e.kind === 'schedule' && (!id(e.emits) || !deadlineIds.has(e.deadlineId) || (e.anchorEvent !== undefined && !id(e.anchorEvent)))) fail('EFFECT_INVALID', rpath, 'Invalid schedule effect');
      if (e.kind === 'record') {
        if (e.emits !== undefined && !id(e.emits)) fail('EFFECT_INVALID', rpath, 'Invalid emitted event');
        for (const [k, v] of Object.entries(e.setFacts ?? {})) if (!factIds.has(k) || typeof v !== factTypes[k]) fail('EFFECT_FACT_INVALID', rpath, 'Recorded fact ' + k + ' is undeclared or mistyped');
        if (e.status && (!['right', 'permission', 'prohibition'].includes(e.status.force) || !actorIds.has(e.status.holderId) || !id(e.status.action))) fail('EFFECT_INVALID', rpath, 'Invalid legal status');
        if (e.transfer && (!id(e.transfer.account) || !id(e.transfer.to) || factTypes[e.transfer.amountFact] !== 'number')) fail('EFFECT_INVALID', rpath, 'Invalid resource transfer');
      }
      if (!Object.hasOwn(pack.explanations, r.explanationKey)) fail('EXPLANATION_MISSING', rpath, 'No authored explanation for ' + r.explanationKey);
      rules.push({ ...r, sourceRefs: pinAll(r.sourceRefs, rpath + '.sourceRefs', f.sourceId),
        effect: { ...e, ...(e.exceptions ? { exceptions: e.exceptions.map((x, xi) => {
          if (!id(x.id) || !text(x.label, 300)) fail('EXCEPTION_LABEL_INVALID', rpath, 'Each exception needs a label');
          return { ...x, sourceRefs: pinAll(x.sourceRefs, rpath + '.effect.exceptions[' + xi + ']', f.sourceId) };
        }) } : {}) } as EffectBinding<SourceRef> });
    }
    const language = JSON.stringify({ schemaVersion: 1, rules: rules.map(r => ({
      id: r.id, versionId: f.versionId, modal: r.modal, sourceRefs: r.sourceRefs, trigger: { event: r.trigger },
      when: r.when, exceptions: r.exceptions, effect: { operation: r.operation, actorId: r.actorId }, explanationKey: r.explanationKey })) });
    const compiled = compileRuleModel(language, {
      versionId: f.versionId, sourceDigest: doc.sourceDigest,
      provisions: doc.provisions.map(p => ({ id: p.id, text: p.text })),
      actors: [...actorIds], externalEvents: [...reachable],
      precedence: rules.filter(r => r.after?.length).map(r => ({ ruleId: r.id, after: r.after! })),
      factTypes, capabilities: PACK_CAPABILITIES.operations
    });
    for (const d of compiled.diagnostics) fail(d.code, path + ' ' + d.path, 'Rule compilation failed');
    if (!compiled.compiled) continue;
    // Explicit, source-mapped coverage: a summary without a rule is never "modeled".
    const dependents = new Map(compiled.compiled.sourceDependencies.map(d => [d.provisionId, d.ruleIds]));
    const mapping = new Map<string, { mode: CoverageReport['entries'][number]['mode']; reason: string | null }>();
    for (const [ci, c] of f.coverage.entries()) {
      const target = byPath.get(f.sourceId)!.get(c?.provision);
      if (!target || !['modeled', 'explanatory-only', 'ambiguous', 'unsupported'].includes(c.mode) || mapping.has(target.id)) { fail('COVERAGE_MAPPING_INVALID', path + '.coverage[' + ci + ']', 'Unknown or duplicate provision'); continue; }
      if (c.mode !== 'modeled' && c.mode !== 'explanatory-only' && !text(c.reason, 1000)) fail('COVERAGE_REASON_MISSING', path + '.coverage[' + ci + ']', 'Unresolved or unsupported provisions need a reason');
      if (c.mode === 'modeled' && !dependents.has(target.id)) fail('COVERAGE_MODELED_WITHOUT_RULE', path + '.coverage[' + ci + ']', 'No operative rule cites ' + target.citation);
      mapping.set(target.id, { mode: c.mode, reason: c.reason ?? null });
    }
    const counts = { modeled: 0, 'explanatory-only': 0, ambiguous: 0, unsupported: 0, unmapped: 0 };
    const entries = doc.provisions.map(p => {
      const m = mapping.get(p.id) ?? { mode: 'unmapped' as const, reason: null };
      counts[m.mode]++;
      return { provisionId: p.id, path: p.path, mode: m.mode, reason: m.reason, ruleIds: dependents.get(p.id) ?? [] };
    });
    if (counts.unmapped) fail('COVERAGE_UNMAPPED', path + '.coverage', counts.unmapped + ' provisions have no coverage declaration');
    const partial = counts['explanatory-only'] + counts.ambiguous + counts.unsupported;
    coverage.push({ frameworkId: f.id, counts, entries,
      statement: counts.modeled + ' of ' + doc.provisions.length + ' provisions are modeled as executable rules; ' + counts['explanatory-only'] + ' are explanatory only, ' +
        counts.ambiguous + ' are marked ambiguous and ' + counts.unsupported + ' are unsupported.' + (partial ? ' This is partial coverage.' : '') });
    frameworks.push({ ...f, rules, sourceDigest: doc.sourceDigest, ruleOrder: compiled.compiled.orderedRules.map(r => r.id) });
  }

  const glossary = pack.glossary.map((g, i) => {
    if (!text(g.term, 120) || !text(g.plain, 600) || !text(g.detail, 2000) || !list(g.aliases, 20) || !list(g.related, 20)) fail('GLOSSARY_INVALID', '$.glossary[' + i + ']', 'Invalid glossary entry');
    return { ...g, sourceRefs: pinAll(g.sourceRefs, '$.glossary[' + i + '].sourceRefs', defaultSource, 0) };
  });
  for (const [k, v] of Object.entries(pack.explanations)) if (!id(k) || !v || !text(v.plain, 600) || !text(v.detail, 2000)) fail('EXPLANATION_INVALID', '$.explanations.' + k, 'Explanation needs plain and detailed text');
  for (const [k, v] of Object.entries(pack.eventLabels)) if (!id(k) || !text(v, 200)) fail('EVENT_LABEL_INVALID', '$.eventLabels.' + k, 'Invalid event label');

  const actions = new Set(pack.frameworks.flatMap(f => f.rules.flatMap(r => r?.effect?.kind === 'create-obligation' ? [r.effect.action] : r?.effect?.kind === 'route' && r.effect.transitAction ? [r.effect.transitAction] : [])));
  const checkpoints = new Set(pack.frameworks.flatMap(f => f.rules.flatMap(r => r?.effect?.checkpoint ? [r.effect.checkpoint] : [])));
  for (const [si, s] of pack.scenarios.entries()) {
    const path = '$.scenarios[' + si + ']';
    if (!text(s.title, 200) || !text(s.question, 300) || !text(s.summary, 2000) || s.hypothetical !== true || !date(s.startDate) ||
        !calendarIds.has(s.calendarId) || !Number.isSafeInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff ||
        !Number.isSafeInteger(s.horizonDays) || s.horizonDays < 1 || s.horizonDays > 3650 ||
        !s.enactment || typeof s.enactment.assume !== 'boolean' || !Number.isSafeInteger(s.enactment.offsetDays) || Math.abs(s.enactment.offsetDays) > 3650 ||
        !s.facts || typeof s.facts !== 'object' || !list(s.unknownFacts, 50) || !s.interpretationChoices || typeof s.interpretationChoices !== 'object' ||
        !list(s.events, 200) || !s.events.length || !list(s.behaviors, 100) || !list(s.parameters, 40) || !list(s.assumptions, 100) ||
        !list(s.unresolved, 50) || !list(s.learn, 20) || !s.expected || typeof s.expected !== 'object') {
      fail('SCENARIO_INVALID', path, 'Invalid scenario specification'); continue;
    }
    for (const [k, v] of Object.entries(s.facts)) if (!factIds.has(k) || typeof v !== factTypes[k]) fail('SCENARIO_FACT_INVALID', path + '.facts.' + k, 'Undeclared or mistyped fact');
    for (const u of s.unknownFacts) if (!factIds.has(u.factId) || Object.hasOwn(s.facts, u.factId) || !text(u.reason, 600)) fail('SCENARIO_UNKNOWN_INVALID', path + '.unknownFacts', 'Unknown facts must be declared, absent from facts and explained');
    for (const [k, v] of Object.entries(s.interpretationChoices)) if (!pack.interpretations.find(c => c.id === k)?.alternatives.some(a => a.id === v)) fail('SCENARIO_INTERPRETATION_INVALID', path + '.interpretationChoices.' + k, 'Unknown interpretation alternative');
    const eventIds = new Set<string>();
    for (const e of s.events) {
      if (!e || !id(e.id) || eventIds.has(e.id) || !Number.isSafeInteger(e.day) || e.day < 0 || e.day > s.horizonDays || !id(e.kind) || !actorIds.has(e.actorId) || !text(e.label, 300)) fail('SCENARIO_EVENT_INVALID', path + '.events', 'Invalid scripted event');
      else eventIds.add(e.id);
    }
    const behaved = new Set<string>();
    for (const b of s.behaviors) {
      if (!b || !actions.has(b.action) || behaved.has(b.action) || !['perform-after', 'never'].includes(b.mode) || !assumptionIds.has(b.assumptionId) ||
          (b.mode === 'perform-after' && (!b.delay || !Number.isSafeInteger(b.delay.amount) || b.delay.amount < 0 || b.delay.amount > 3650 || !['calendar-day', 'business-day'].includes(b.delay.unit))))
        fail('SCENARIO_BEHAVIOR_INVALID', path + '.behaviors', 'Actor behavior must name a declared action and a labeled assumption');
      else behaved.add(b.action);
    }
    for (const a of s.assumptions) if (!assumptionIds.has(a)) fail('SCENARIO_ASSUMPTION_UNKNOWN', path + '.assumptions', 'Unknown assumption ' + a);
    const paramIds = new Set<string>();
    for (const p of s.parameters) {
      const t = p?.target;
      if (!p || !id(p.id) || paramIds.has(p.id) || !text(p.label, 200) || !text(p.help, 600) || !t ||
          (t.kind === 'fact' && (!factIds.has(t.factId) || (p.control === 'integer') !== (factTypes[t.factId] === 'number') || (factTypes[t.factId] === 'boolean' && !['boolean', 'tristate'].includes(p.control)))) ||
          ((t.kind === 'behavior-delay' || t.kind === 'behavior-mode') && !behaved.has(t.action)) ||
          (t.kind === 'interpretation' && !interpretationIds.has(t.interpretationId)) ||
          (p.control === 'integer' && (!Number.isSafeInteger(p.min) || !Number.isSafeInteger(p.max) || p.min! > p.max!)) ||
          (p.control === 'choice' && (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 20)) ||
          (p.assumptionId !== undefined && !assumptionIds.has(p.assumptionId)))
        fail('SCENARIO_PARAMETER_INVALID', path + '.parameters', 'Parameter controls must be bounded and target declared inputs');
      else paramIds.add(p.id);
    }
    if (s.workload && (!actions.has(s.workload.action) || !assumptionIds.has(s.workload.assumptionId) || !['assumption', 'empirical'].includes(s.workload.sourceKind) ||
        ![s.workload.arrivalsPerDay, s.workload.workers, s.workload.unitsPerWorkerDay, s.workload.unitsPerItem].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000) ||
        s.workload.unitsPerItem < 1 || !Array.isArray(s.workload.outageDays)))
      fail('SCENARIO_WORKLOAD_INVALID', path + '.workload', 'Workload models need labeled, bounded inputs');
    for (const [fid, expected] of Object.entries(s.expected)) {
      if (!frameworkIds.has(fid) || !list(expected, 100)) { fail('SCENARIO_EXPECTED_INVALID', path + '.expected.' + fid, 'Unknown framework'); continue; }
      for (const x of expected) if (!x || !checkpoints.has(x.checkpoint) || typeof x.present !== 'boolean' || !text(x.reasoning, 1000)) fail('SCENARIO_EXPECTED_INVALID', path + '.expected.' + fid, 'Each expectation names a checkpoint and independent reasoning');
    }
    for (const f of pack.frameworks) if (!Object.hasOwn(s.expected, f.id)) fail('SCENARIO_EXPECTED_MISSING', path + '.expected', 'No independent expectation for ' + f.id);
  }
  const scene = pack.scene;
  if (!id(scene.id) || !text(scene.title, 200) || !list(scene.nodes, 200) || !list(scene.edges, 400) || !list(scene.groups, 50) ||
      !Number.isSafeInteger(scene.width) || !Number.isSafeInteger(scene.height) || scene.width < 200 || scene.height < 200 || scene.width > 4000 || scene.height > 4000)
    fail('SCENE_INVALID', '$.scene', 'Invalid scene');
  else {
    const placed = new Set(scene.nodes.map(n => n.actorId));
    for (const n of scene.nodes) if (!actorIds.has(n.actorId) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) fail('SCENE_NODE_INVALID', '$.scene.nodes', 'Scene nodes must be declared actors');
    for (const e of scene.edges) if (!id(e.id) || !placed.has(e.from) || !placed.has(e.to) || !['route', 'authority'].includes(e.kind) || !text(e.label, 120) || !Array.isArray(e.eventKinds)) fail('SCENE_EDGE_INVALID', '$.scene.edges', 'Scene edges connect placed actors');
  }
  if (diagnostics.length) return failure();

  const { sources: _sources, ...rest } = pack;
  void _sources;
  const release: PackRelease = { ...rest, schemaVersion: '1.0.0', engineVersion: PACK_ENGINE_VERSION, documents, deadlines, frameworks, interpretations, glossary, coverage, requires: PACK_CAPABILITIES };

  // Reuse the merged contract and coverage validators on an equivalent v1 bundle.
  for (const f of frameworks) {
    const doc = documentBySource.get(f.sourceId)!;
    const bundle: ModelBundle = {
      schemaVersion: '1.0.0',
      billVersions: [{ id: f.versionId, billId: f.billId, version: f.version, status: f.status, jurisdiction: f.jurisdiction, sourceDigest: doc.sourceDigest }],
      provisions: doc.provisions.map(p => ({ id: p.id, versionId: p.versionId, citation: p.citation, text: p.text, ...(p.parentId ? { parentId: p.parentId } : {}),
        source: { versionId: p.versionId, provisionId: p.id, sourceDigest: doc.sourceDigest, quote: p.text.slice(0, 120) } })),
      actors: pack.actors.map(a => ({ id: a.id, name: a.name, kind: a.kind })), assumptions: [],
      rules: f.rules.map(r => ({ id: r.id, versionId: f.versionId, sourceRefs: r.sourceRefs, modal: r.modal, operation: r.operation })),
      scenarios: [], releases: [], traces: []
    };
    const contract = validateBundle(bundle);
    for (const d of contract.diagnostics) fail('CONTRACT_' + d.code, '$.frameworks.' + f.id + ' ' + d.path, d.message);
    if (!contract.valid) continue;
    const report = coverage.find(c => c.frameworkId === f.id)!;
    const assessment = assessCoverage(bundle, { versionId: f.versionId, baselineDate: f.asOf, hypothetical: true,
      mappings: report.entries.filter(e => e.mode !== 'unmapped').map(e => ({ provisionId: e.provisionId, mode: e.mode as 'modeled', ...(e.reason ? { reason: e.reason } : e.mode === 'modeled' || e.mode === 'explanatory-only' ? {} : { reason: 'unspecified' }) })),
      requires: { ...PACK_CAPABILITIES, operations: [...new Set(f.rules.map(r => r.operation))] } }, PACK_CAPABILITIES);
    if (!assessment.canRunPartialModel) for (const d of assessment.diagnostics) fail('COVERAGE_' + d.code, '$.frameworks.' + f.id, d.message);
  }
  if (diagnostics.length) return failure();

  const bundleBytes = new TextEncoder().encode(canonicalJSON(release));
  const bundlePath = 'assets/' + await sha256Hex(bundleBytes) + '.json';
  assets.set(bundlePath, bundleBytes);
  const primary = documentBySource.get(defaultSource)!;
  const manifest: PackManifest = {
    schemaVersion: '1.0.0', format: PACK_FORMAT, packId: pack.packId, label: pack.releaseLabel,
    releaseId: pack.packId + '@' + pack.releaseLabel, engineVersion: PACK_ENGINE_VERSION, bundlePath,
    sourceDigest: primary.sourceDigest,
    assets: [...assets.keys()].sort().map(path => ({ path, digest: path.slice(7, 71) }))
  };
  return { valid: true, diagnostics: [], release, manifest, manifestDigest: await canonicalDigest(manifest), assets, primarySourceBytes: sourceBytes.get(defaultSource)!.slice() };
}
