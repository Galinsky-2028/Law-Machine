import { describe, expect, it } from 'vitest';
import { buildAndVerify, executablePackIds, loadAuthoredPack } from '../../scripts/packs.ts';
import { buildPackRelease } from '../../packages/legislation/src/pack-builder.ts';
import { canonicalDigest, canonicalJSON, generateSigningKey, signManifest, verifyReleaseSignature, type PackRelease, type TrustStore } from '../../packages/contracts/src/index.ts';
import { comparePack, exportRun, prepareScenario, runPackScenario, stressScenario, verifyRunExport, explainEvent, MAX_STRESS_SAMPLES } from '../../packages/simulation/src/index.ts';
import { loadPackRelease, PackSdkError } from '../../packages/sdk/src/index.ts';
import { buildSearchDocs, checkpointSteps, decodeShare, encodeShare, playbackState, search, sequenceView } from '../../packages/presentation/src/index.ts';

const meridian = await buildAndVerify('meridian-claims');
const release = meridian.built.release!;
const digest = meridian.built.manifestDigest!;
const scenario = (id: string) => release.scenarios.find(s => s.id === id)!;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('pack builds and golden expectations', () => {
  it('builds every executable pack and passes every independently written expectation', async () => {
    const ids = await executablePackIds();
    expect(ids).toEqual(['lakeside-library-budget', 'meridian-claims', 'riverbend-permits']);
    for (const id of ids) {
      const report = await buildAndVerify(id);
      expect(report.built.diagnostics).toEqual([]);
      expect(report.golden.filter(g => !g.passed)).toEqual([]);
      expect(report.golden.length).toBeGreaterThan(30);
    }
  });
  it('is deterministic: rebuilding gives the same manifest digest', async () => {
    expect((await buildAndVerify('meridian-claims')).built.manifestDigest).toBe(digest);
  });
  it('fails closed when a cited quote does not occur verbatim in the pinned source', async () => {
    const { pack, bytes } = await loadAuthoredPack('meridian-claims');
    const bad = clone(pack) as { frameworks: { rules: { sourceRefs: { quote: string }[] }[] }[] };
    bad.frameworks[1]!.rules[0]!.sourceRefs[0]!.quote = 'A submission is received when an employee reads it.';
    const built = await buildPackRelease(bad, bytes);
    expect(built.valid).toBe(false);
    expect(built.diagnostics.map(d => d.code)).toContain('REF_QUOTE_NOT_FOUND');
  });
  it('detects changed source bytes as stale provenance instead of relinking', async () => {
    const { pack, bytes } = await loadAuthoredPack('meridian-claims');
    const edited = new Map(bytes);
    edited.set('claims-act', new TextEncoder().encode(new TextDecoder().decode(bytes.get('claims-act')).replace('within 2 business days', 'within 5 business days')));
    const built = await buildPackRelease(pack, edited);
    expect(built.valid).toBe(false);
    expect(built.diagnostics.some(d => d.code === 'REF_QUOTE_NOT_FOUND')).toBe(true);
  });
  it('refuses a provision marked modeled without an operative rule, and a rule without provenance', async () => {
    const { pack, bytes } = await loadAuthoredPack('meridian-claims');
    const bad = clone(pack) as { frameworks: { coverage: { provision: string; mode: string }[]; rules: { sourceRefs: unknown[] }[] }[] };
    bad.frameworks[1]!.coverage.find(c => c.provision === '1(a)')!.mode = 'modeled';
    bad.frameworks[0]!.rules[0]!.sourceRefs = [];
    const codes = (await buildPackRelease(bad, bytes)).diagnostics.map(d => d.code);
    expect(codes).toContain('COVERAGE_MODELED_WITHOUT_RULE');
    expect(codes).toContain('REFS_REQUIRED');
  });
  it('requires every provision to carry an explicit coverage declaration', async () => {
    const { pack, bytes } = await loadAuthoredPack('meridian-claims');
    const bad = clone(pack) as { frameworks: { coverage: unknown[] }[] };
    bad.frameworks[1]!.coverage.pop();
    expect((await buildPackRelease(bad, bytes)).diagnostics.map(d => d.code)).toContain('COVERAGE_UNMAPPED');
  });
  it('rejects real-law packs that mix in invented text or lack dated official sources', async () => {
    const { pack, bytes } = await loadAuthoredPack('meridian-claims');
    const bad = clone(pack) as { fictional: boolean; sources: { kind: string }[] };
    bad.fictional = false;
    const codes = (await buildPackRelease(bad, bytes)).diagnostics.map(d => d.code);
    expect(codes).toContain('REAL_PACK_FICTIONAL_SOURCE');
    expect(codes).toContain('SOURCE_RETRIEVAL_UNRECORDED');
  });
  it('rejects unresolved same-trigger rule conflicts without explicit precedence', async () => {
    const { pack, bytes } = await loadAuthoredPack('meridian-claims');
    const bad = clone(pack) as { frameworks: { rules: { id: string; after?: string[] }[] }[] };
    delete bad.frameworks[0]!.rules.find(r => r.id === 'reg-return-missing-amount')!.after;
    expect((await buildPackRelease(bad, bytes)).diagnostics.map(d => d.code)).toContain('COMPILE_RULE_CONFLICT_UNRESOLVED');
  });
});

describe('legal semantics', () => {
  it('never runs a proposal as law without an explicit enactment assumption', () => {
    const s = clone(scenario('wrong-agency'));
    expect(() => runPackScenario(release, 'proposal', { ...s, enactment: { assume: false, offsetDays: -400 } })).toThrow('ENACTMENT_ASSUMPTION_REQUIRED');
    expect(runPackScenario(release, 'proposal', s).warnings).toContain('HYPOTHETICAL_ENACTMENT_NOT_CURRENT_LAW');
  });
  it('records a missed duty without moving the protected date', () => {
    const run = runPackScenario(release, 'proposal', scenario('missed-routing'));
    expect(run.duties.find(d => d.action === 'transfer-claim')!.state).toBe('breached');
    expect(run.checkpoints.find(c => c.semanticKey === 'presentment')!.eventTick).toBe(0);
  });
  it('a duty alone never causes performance: with no behavior the result is unknown', () => {
    const s = clone(scenario('wrong-agency'));
    const run = runPackScenario(release, 'proposal', { ...s, behaviors: [] });
    expect(run.duties[0]!.state).toBe('unknown');
    expect(run.events.some(e => e.kind === 'performed:transfer-claim')).toBe(false);
    expect(run.state).toBe('unresolved');
  });
  it('keeps unknown facts unknown instead of treating them as false', () => {
    const run = runPackScenario(release, 'baseline', scenario('unknown-responsibility'));
    expect(run.state).toBe('unresolved');
    expect(run.events.filter(e => e.category === 'unresolved').every(e => e.unresolved.includes('responsibleAgencyReceived'))).toBe(true);
    expect(run.duties).toEqual([]);
  });
  it('shows an unresolved interpretation until a reading is chosen, then follows that reading', () => {
    const open = runPackScenario(release, 'proposal', scenario('missing-amount'));
    expect(open.checkpoints.find(c => c.semanticKey === 'disposition-clock')!.dutyState).toBe('unknown');
    for (const [reading, start] of [['relation-back', 0], ['amount-supplied', 14]] as const) {
      const p = prepareScenario(release, 'missing-amount', { reading });
      const point = runPackScenario(p.release, 'proposal', p.scenario).checkpoints.find(c => c.semanticKey === 'disposition-clock')!;
      expect(point.unresolved).toEqual([]);
      expect(point.eventTick).toBe(start);
    }
  });
  it('accepts "no reading chosen" as a valid setting that keeps the conflict unresolved', () => {
    const p = prepareScenario(release, 'missing-amount', { reading: null });
    expect(p.issues).toEqual([]);
    expect(runPackScenario(p.release, 'proposal', p.scenario).state).toBe('unresolved');
    const back = prepareScenario(release, 'late-deficiency-notice', { reading: null });
    expect(back.scenario.interpretationChoices).toEqual({});
  });
  it('applies staged effective dates', () => {
    const run = runPackScenario(release, 'proposal', scenario('phased-implementation'));
    expect(run.events.filter(e => e.category === 'not-effective').map(e => e.kind)).toContain('act-missing-amount-notice');
    expect(run.events.some(e => e.kind === 'act-receipt-time' && e.category === 'rule')).toBe(true);
  });
  it('conserves money exactly and refuses overdrafts', async () => {
    const lib = (await buildAndVerify('lakeside-library-budget')).built.release!;
    const run = runPackScenario(lib, 'proposal', lib.scenarios.find(s => s.id === 'tight-funds')!);
    const total = ['generalFund', 'northBranch', 'southBranch', 'reserveFund'].reduce((n, k) => n + (run.facts[k] as number), 0);
    expect(total).toBe(420000);
    expect(run.events.some(e => e.category === 'exception' && e.unresolved.includes('INSUFFICIENT_BALANCE'))).toBe(true);
  });
  it('is deterministic across repeated runs', () => {
    const a = runPackScenario(release, 'proposal', scenario('missed-routing'));
    const b = runPackScenario(release, 'proposal', scenario('missed-routing'));
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
  it('bounds runaway runs with a disclosed limit', () => {
    const run = runPackScenario(release, 'proposal', scenario('missed-routing'), { maxEvents: 3 });
    expect(run.state).toBe('limited');
    expect(run.warnings.some(w => w.startsWith('RUN_TERMINATED'))).toBe(true);
  });
});

describe('comparison, explanation and sandbox', () => {
  it('changes only the legal framework and explains the date change from sources', async () => {
    const c = await comparePack(release, digest, scenario('wrong-agency'));
    expect(c.comparison.hypotheticalEnactment).toBe(true);
    const presentment = c.comparison.changes.find(x => x.semanticKey === 'presentment')!;
    expect(presentment.baseline!.eventTick).toBe(1);
    expect(presentment.proposal!.eventTick).toBe(0);
    const event = c.proposal.events.find(e => e.checkpoint === 'presentment' && e.category === 'rule')!;
    const why = explainEvent(release, c.proposal, event.id);
    expect(why.excerpts.map(x => x.citation)).toContain('§ 4(b)');
    expect(why.excerpts.every(x => !x.stale)).toBe(true);
  });
  it('never gives confident prose for an unresolved outcome', () => {
    const run = runPackScenario(release, 'proposal', scenario('missing-amount'));
    const event = run.events.find(e => e.outcome === 'unknown')!;
    expect(explainEvent(release, run, event.id).plain).toMatch(/^Unresolved in this model/);
  });
  it('validates visitor parameters and labels sandbox rule edits', () => {
    const bad = prepareScenario(release, 'wrong-agency', { 'transfer-delay': 999, injected: 'x' });
    expect(bad.issues.map(i => i.parameterId).sort()).toEqual(['injected', 'transfer-delay']);
    const fork = prepareScenario(release, 'wrong-agency', {}, { disabledRules: { proposal: ['act-routing-duty'] } });
    expect(fork.modifiedRules).toBe(true);
    expect(fork.release.frameworks.find(f => f.id === 'proposal')!.label).toMatch(/sandbox/);
    expect(prepareScenario(release, 'wrong-agency').modified).toBe(false);
  });
  it('recomputes exports: a forged outcome or altered parameters fail verification', async () => {
    const p = prepareScenario(release, 'missed-routing');
    const run = runPackScenario(p.release, 'proposal', p.scenario);
    const exported = await exportRun(release, 'meridian-claims@x', digest, p, run);
    expect((await verifyRunExport(release, digest, exported)).valid).toBe(true);
    const forged = clone(exported);
    (forged.summary.duties[0] as { state: string }).state = 'satisfied';
    expect((await verifyRunExport(release, digest, forged)).reason).toBe('OUTCOME_MISMATCH');
    expect((await verifyRunExport(release, digest, { ...exported, parameters: { 'transfer-delay': 1 } })).valid).toBe(false);
    await expect(exportRun(release, 'x', digest, prepareScenario(release, 'missed-routing', {}, { disabledRules: { proposal: ['act-routing-duty'] } }), run)).rejects.toThrow('SANDBOX');
  });
  it('bounds and labels stress runs; legal due date never moves', async () => {
    const r = await stressScenario(release, digest, scenario('wrong-agency'), { frameworkId: 'proposal', samples: 40, arrivalsPerDay: 10, workers: 1, unitsPerWorkerDay: 6, outageDays: [1, 2] });
    expect(r.satisfied + r.breached + r.neverPerformed).toBe(40);
    expect(r.legalDue).toBe('2027-03-03');
    expect(r.methodology).toMatch(/not a prediction/);
    await expect(stressScenario(release, digest, scenario('wrong-agency'), { frameworkId: 'proposal', samples: MAX_STRESS_SAMPLES + 1, arrivalsPerDay: 1, workers: 1, unitsPerWorkerDay: 1, outageDays: [] })).rejects.toThrow('STRESS_REQUEST_OUT_OF_BOUNDS');
    await expect(stressScenario(release, digest, scenario('wrong-agency'), { frameworkId: 'proposal', samples: 5, arrivalsPerDay: 1, workers: 1, unitsPerWorkerDay: 1, outageDays: [] }, { cancelled: true })).rejects.toThrow('STRESS_CANCELLED');
  });
});

describe('signatures, SDK integrity and presentation', () => {
  const trustFor = async () => {
    const key = await generateSigningKey();
    const trust: TrustStore = { format: 'law-machine-trust-v1', keys: [{ keyId: 'k1', algorithm: 'ECDSA-P256-SHA256', publicKeyJwk: key.publicKeyJwk, status: 'active', validFrom: '2026-01-01', validUntil: null, revokedAt: null, note: 'test' }] };
    return { key, trust };
  };
  it('verifies signatures, rejects tampering, unknown and revoked keys, and keys used outside validity', async () => {
    const { key, trust } = await trustFor();
    const sig = await signManifest(key.privateKeyJwk, 'k1', digest, '2026-11-14T00:00:00Z');
    expect((await verifyReleaseSignature(trust, digest, sig)).valid).toBe(true);
    expect((await verifyReleaseSignature(trust, 'f'.repeat(64), sig)).reason).toBe('DIGEST_MISMATCH');
    expect((await verifyReleaseSignature(trust, digest, { ...sig, signature: sig.signature.slice(0, -4) + 'AAAA' })).reason).toBe('BAD_SIGNATURE');
    expect((await verifyReleaseSignature(trust, digest, { ...sig, signedAt: '2026-11-15T00:00:00Z' })).reason).toBe('BAD_SIGNATURE');
    const revoked: TrustStore = { ...trust, keys: [{ ...trust.keys[0]!, status: 'revoked', revokedAt: '2026-12-01' }] };
    expect((await verifyReleaseSignature(revoked, digest, sig)).reason).toBe('KEY_REVOKED');
    const retired: TrustStore = { ...trust, keys: [{ ...trust.keys[0]!, status: 'retired', validUntil: '2026-06-01T00:00:00Z' }] };
    expect((await verifyReleaseSignature(retired, digest, sig)).reason).toBe('OUTSIDE_KEY_VALIDITY');
    expect((await verifyReleaseSignature({ format: 'law-machine-trust-v1', keys: [] }, digest, sig)).reason).toBe('UNKNOWN_KEY');
    expect('d' in trust.keys[0]!.publicKeyJwk).toBe(false);
  });
  it('SDK loads only verified releases and exposes the headless consumer contract', async () => {
    const { key, trust } = await trustFor();
    const manifestBytes = new TextEncoder().encode(canonicalJSON(meridian.built.manifest));
    expect(await canonicalDigest(meridian.built.manifest)).toBe(digest);
    const signature = await signManifest(key.privateKeyJwk, 'k1', digest, '2026-11-14T00:00:00Z');
    const session = await loadPackRelease({ manifestBytes, expectedManifestDigest: digest, assets: meridian.built.assets, signature, trust, requireSignature: true });
    expect(session.signature.valid).toBe(true);
    expect(session.resolveCitation({ versionId: 'meridian-act-draft-1', citation: '§ 4(b)' }).status).toBe('resolved');
    expect(session.getGlossaryEntry('wrong agency')?.id).toBe('routing');
    const { run } = session.runScenario('wrong-agency');
    expect(session.getSceneFocusTarget({ kind: 'checkpoint', id: 'presentment' }, run).found).toBe(true);
    const tampered = new Map(meridian.built.assets);
    const bundle = meridian.built.manifest!.bundlePath;
    tampered.set(bundle, new TextEncoder().encode(new TextDecoder().decode(tampered.get(bundle)).replace('2 business days', '9 business days')));
    await expect(loadPackRelease({ manifestBytes, expectedManifestDigest: digest, assets: tampered })).rejects.toBeInstanceOf(PackSdkError);
    await expect(loadPackRelease({ manifestBytes, expectedManifestDigest: 'a'.repeat(64), assets: meridian.built.assets })).rejects.toThrow(/verification/);
    await expect(loadPackRelease({ manifestBytes, expectedManifestDigest: digest, assets: meridian.built.assets, requireSignature: true })).rejects.toThrow(/signature/);
  });
  it('scrubbing reconstructs state as a pure function of the step', () => {
    const run = runPackScenario(release, 'proposal', scenario('missed-routing'));
    const forward = Array.from({ length: run.events.length + 1 }, (_, i) => playbackState(release, run, i));
    const backward = Array.from({ length: run.events.length + 1 }, (_, i) => playbackState(release, run, run.events.length - i)).reverse();
    expect(canonicalJSON(forward)).toBe(canonicalJSON(backward));
    const end = forward.at(-1)!;
    expect(end.duties.find(d => d.action === 'transfer-claim')!.state).toBe('breached');
    expect(checkpointSteps(run).length).toBeGreaterThan(3);
    expect(sequenceView(release, run).flatMap(d => d.items).length).toBe(run.events.length);
  });
  it('search finds concepts without section numbers and indexes published content only', () => {
    const docs = buildSearchDocs(release, '/packs/meridian-claims');
    for (const [q, expected] of [['wrong agency', 'g:routing'], ['presentment', 'g:presentment'], ['denial', 'g:deemed-denial']] as const)
      expect(search(docs, q).slice(0, 3).map(h => h.id)).toContain(expected);
    expect(search(docs, '<script>')).toEqual([]);
  });
  it('share links carry only allowlisted parameters', () => {
    const s = scenario('wrong-agency');
    const q = encodeShare(s, { packId: 'meridian-claims', release: digest, scenarioId: s.id, framework: 'proposal', step: 4, params: { 'transfer-delay': 5, responsible: null } });
    const back = decodeShare(s, q + '&p.injected=hello&p.transfer-delay2=1&note=private+facts');
    expect(back.params).toEqual({ 'transfer-delay': 5, responsible: null });
    expect(back.release).toBe(digest);
    expect(back.rejected).toContain('p.injected');
    expect(q).not.toMatch(/note|private/);
  });
});

describe('release is detached from authoring input', () => {
  it('contains no file paths or private fields from the authored pack', () => {
    const text = canonicalJSON(release as PackRelease);
    expect(text).not.toMatch(/"file":|\/home\/|sources\//);
  });
});
