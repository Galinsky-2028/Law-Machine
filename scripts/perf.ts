import { writeFileSync } from 'node:fs';
import { buildAndVerify } from './packs.ts';
import { comparePack, runPackScenario, stressScenario } from '../packages/simulation/src/index.ts';

/** LM-055 reference measurements. Prints JSON; pass --write to store docs/evidence/performance-engine.json. */
const meridian = await buildAndVerify('meridian-claims');
const release = meridian.built.release!, digest = meridian.built.manifestDigest!;
const base = release.scenarios.find(s => s.id === 'missed-routing')!;
// Reference large run: 1,700 independent wrong-agency claims over 200 days.
const events = Array.from({ length: 1700 }, (_, i) => ({ id: 'c' + i, day: i % 120, kind: 'claim-submitted', actorId: 'claimant', label: 'Claim ' + i }));
const large = { ...base, id: 'reference-large', events, horizonDays: 300 };
const time = (fn: () => unknown, n = 5) => { const t: number[] = []; let r: unknown; for (let i = 0; i < n; i++) { const s = performance.now(); r = fn(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return { medianMs: Math.round(t[Math.floor(n / 2)]! * 10) / 10, result: r }; };
const big = time(() => runPackScenario(release, 'proposal', large, { maxEvents: 20000 }));
const bigRun = big.result as ReturnType<typeof runPackScenario>;
const small = time(() => runPackScenario(release, 'proposal', base), 50);
const cmpStart = performance.now(); for (let i = 0; i < 20; i++) await comparePack(release, digest, base); const cmp = (performance.now() - cmpStart) / 20;
const sStart = performance.now(); await stressScenario(release, digest, release.scenarios.find(s => s.id === 'wrong-agency')!, { frameworkId: 'proposal', samples: 400, arrivalsPerDay: 6, workers: 1, unitsPerWorkerDay: 8, outageDays: [] }); const stress = performance.now() - sStart;
const bundleBytes = [...meridian.built.assets.values()].reduce((n, b) => n + b.byteLength, 0);
const report = { measuredAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform + '-' + process.arch, note: 'Cloud container, single core share; not a user device.' },
  referenceRun: { events: bigRun.events.length, state: bigRun.state, medianMs: big.medianMs, target: '<= 1000 ms for 10,000 events (desktop profile)' },
  typicalScenario: { events: (small.result as ReturnType<typeof runPackScenario>).events.length, medianMs: small.medianMs },
  comparisonMs: Math.round(cmp * 10) / 10, stress400SamplesMs: Math.round(stress), releaseUncompressedBytes: bundleBytes };
console.log(JSON.stringify(report, null, 1));
if (process.argv.includes('--write')) writeFileSync(new URL('../docs/evidence/performance-engine.json', import.meta.url), JSON.stringify(report, null, 1) + '\n');
