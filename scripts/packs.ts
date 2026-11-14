import { mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJSON, type Catalog, type CatalogPack, type PackRelease } from '../packages/contracts/src/index.ts';
import { buildPackRelease, type BuiltPack } from '../packages/legislation/src/pack-builder.ts';
import { inspectFirstPack } from '../packages/legislation/src/pack-readiness.ts';
import { checkGolden, runPackScenario, type GoldenResult, type PackRun } from '../packages/simulation/src/index.ts';
import { signManifest, verifyReleaseSignature, type ReleaseSignature, type TrustStore } from '../packages/contracts/src/signing.ts';

/**
 * Pack build, verification and static publication.
 *   check   build every pack in memory and verify golden scenario expectations
 *   build   also write content-addressed release files and the public catalog
 *   sign    sign the current release manifests (needs LM_RELEASE_SIGNING_KEY)
 */
const root = new URL('../', import.meta.url);
const packsDir = new URL('content/packs/', root);
const releasesDir = new URL('content/releases/', root);
const publicDir = new URL('apps/web/public/releases/', root);

export type PackBuildReport = { readonly packId: string; readonly built: BuiltPack; readonly golden: readonly GoldenResult[]; readonly runs: number };

export async function loadAuthoredPack(packId: string): Promise<{ pack: unknown; bytes: Map<string, Uint8Array> }> {
  const dir = new URL(packId + '/', packsDir);
  const pack = JSON.parse(await readFile(new URL('pack.json', dir), 'utf8')) as { sources?: { id: string; file: string }[] };
  const bytes = new Map<string, Uint8Array>();
  for (const source of pack.sources ?? []) {
    if (!/^sources\/[a-z0-9._-]+$/.test(source.file)) throw Error('SOURCE_PATH_INVALID: ' + source.file);
    bytes.set(source.id, new Uint8Array(await readFile(new URL(source.file, dir))));
  }
  return { pack, bytes };
}
export async function executablePackIds(): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of await readdir(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { await stat(new URL(entry.name + '/pack.json', packsDir)); ids.push(entry.name); } catch { /* inventory-only pack */ }
  }
  return ids.sort();
}
export async function buildAndVerify(packId: string): Promise<PackBuildReport> {
  const { pack, bytes } = await loadAuthoredPack(packId);
  const built = await buildPackRelease(pack, bytes);
  const golden: GoldenResult[] = [];
  let runs = 0;
  if (built.release) {
    for (const scenario of built.release.scenarios) {
      const results: Record<string, PackRun> = {};
      for (const framework of built.release.frameworks) { results[framework.id] = runPackScenario(built.release, framework.id, scenario); runs++; }
      golden.push(...checkGolden(built.release, scenario, results).map(r => ({ ...r, checkpoint: scenario.id + ':' + r.checkpoint })));
    }
  }
  return { packId, built, golden, runs };
}

export type StoredRelease = { manifestDigest: string; releaseId: string; label: string; publishedAt: string; status: 'current' | 'superseded' | 'withdrawn'; note: string | null; signature: ReleaseSignature | null };
type ReleaseIndex = { packId: string; current: string | null; releases: StoredRelease[] };

async function readIndex(packId: string): Promise<ReleaseIndex> {
  try { return JSON.parse(await readFile(new URL(packId + '/index.json', releasesDir), 'utf8')) as ReleaseIndex; }
  catch { return { packId, current: null, releases: [] }; }
}
export async function readTrustStore(): Promise<TrustStore> {
  return JSON.parse(await readFile(new URL('content/trust/release-keys.json', root), 'utf8')) as TrustStore;
}

/** Writes immutable files once; an existing digest is never overwritten with different bytes. */
async function writeImmutable(url: URL, bytes: Uint8Array): Promise<void> {
  try {
    const existing = new Uint8Array(await readFile(url));
    if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) throw Error('IMMUTABLE_ASSET_CONFLICT: ' + url.pathname);
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('IMMUTABLE')) throw error;
  }
  await mkdir(new URL('./', url), { recursive: true });
  await writeFile(url, bytes);
}

export async function publishLocal(report: PackBuildReport): Promise<StoredRelease> {
  const { built, packId } = report;
  if (!built.valid || !built.manifest || !built.manifestDigest) throw Error('BUILD_INVALID');
  const failing = report.golden.filter(g => !g.passed);
  if (failing.length) throw Error('GOLDEN_FAILED: ' + failing.map(f => f.checkpoint).join(', '));
  const dir = new URL(packId + '/' + built.manifestDigest + '/', releasesDir);
  for (const [path, bytes] of built.assets) await writeImmutable(new URL(path, dir), bytes);
  await writeImmutable(new URL('manifest.json', dir), new TextEncoder().encode(canonicalJSON(built.manifest)));
  const index = await readIndex(packId);
  let entry = index.releases.find(r => r.manifestDigest === built.manifestDigest);
  if (!entry) {
    if (index.releases.some(r => r.label === built.manifest!.label)) throw Error('RELEASE_LABEL_REUSED: bump releaseLabel in ' + packId + '/pack.json');
    for (const r of index.releases) if (r.status === 'current') r.status = 'superseded';
    entry = { manifestDigest: built.manifestDigest, releaseId: built.manifest.releaseId, label: built.manifest.label, publishedAt: built.release!.releasedAt, status: 'current', note: null, signature: null };
    index.releases.push(entry);
    index.current = built.manifestDigest;
  }
  await writeFile(new URL(packId + '/index.json', releasesDir), JSON.stringify(index, null, 1) + '\n');
  return entry;
}

/** Copy committed releases into the static public tree and write the catalog. */
export async function writePublicTree(): Promise<Catalog> {
  await rm(publicDir, { recursive: true, force: true });
  const trust = await readTrustStore();
  const packs: CatalogPack[] = [];
  for (const entry of await readdir(releasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = await readIndex(entry.name);
    let latest: PackRelease | null = null;
    const releases = [];
    for (const r of index.releases) {
      const dir = new URL(entry.name + '/' + r.manifestDigest + '/', releasesDir);
      const manifestBytes = await readFile(new URL('manifest.json', dir));
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      const signed = r.signature ? (await verifyReleaseSignature(trust, r.manifestDigest, r.signature, r.publishedAt)).valid : false;
      const out = new URL(entry.name + '/' + r.manifestDigest + '/', publicDir);
      await mkdir(new URL('assets/', out), { recursive: true });
      await writeFile(new URL('manifest.json', out), manifestBytes);
      if (r.signature) await writeFile(new URL('signature.json', out), JSON.stringify(r.signature));
      for (const asset of manifest.assets as { path: string }[]) await writeFile(new URL(asset.path, out), await readFile(new URL(asset.path, dir)));
      if (r.manifestDigest === index.current) latest = JSON.parse((await readFile(new URL(manifest.bundlePath, dir))).toString('utf8')) as PackRelease;
      releases.push({ releaseId: r.releaseId, manifestDigest: r.manifestDigest, label: r.label, publishedAt: r.publishedAt, status: r.status, note: r.note, signed });
    }
    if (!latest) continue;
    const proposal = latest.frameworks.find(f => f.role === 'proposal') ?? latest.frameworks[0]!;
    const baseline = latest.frameworks.find(f => f.role === 'baseline');
    packs.push({ packId: latest.packId, title: latest.title, question: latest.question, summary: latest.summary, domain: latest.domain, fictional: latest.fictional,
      statusLabel: (latest.fictional ? 'Fictional · ' : '') + ({ draft: 'Draft proposal — not enacted', introduced: 'Introduced proposal — not enacted', enacted: 'Recorded as enacted', repealed: 'Repealed' } as const)[proposal.status],
      jurisdiction: proposal.jurisdiction, baselineAsOf: baseline?.asOf ?? null, scenarioCount: latest.scenarios.length, current: index.current, releases });
  }
  const unavailable = [];
  try {
    const inventory = JSON.parse(await readFile(new URL('electronic-filing/scenario-inventory.json', packsDir), 'utf8'));
    const readiness = inspectFirstPack(inventory);
    if (!readiness.readyForPublication) unavailable.push({ packId: 'electronic-filing', title: 'Federal electronic-filing bill', reason: 'Not published: the authentic complete bill text and dated official baseline sources have not been supplied (' + readiness.diagnostics.slice(0, 3).join(', ') + '). Nothing about this bill is simulated.' });
  } catch { /* no inventory */ }
  const catalog: Catalog = { format: 'law-machine-catalog-v1', generatedFrom: 'content/releases', packs: packs.sort((a, b) => a.packId.localeCompare(b.packId)), unavailable };
  await mkdir(publicDir, { recursive: true });
  await writeFile(new URL('catalog.json', publicDir), JSON.stringify(catalog));
  await writeFile(new URL('trust.json', publicDir), JSON.stringify(trust));
  return catalog;
}

export async function signCurrent(privateKeyJwk: string, keyId: string): Promise<number> {
  let signed = 0;
  for (const entry of await readdir(releasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = await readIndex(entry.name);
    for (const r of index.releases) if (!r.signature && r.status !== 'withdrawn') { r.signature = await signManifest(JSON.parse(privateKeyJwk), keyId, r.manifestDigest, r.publishedAt); signed++; }
    await writeFile(new URL(entry.name + '/index.json', releasesDir), JSON.stringify(index, null, 1) + '\n');
  }
  return signed;
}

function printReport(report: PackBuildReport) {
  const failed = report.golden.filter(g => !g.passed);
  console.log(report.packId + ': ' + (report.built.valid ? 'built ' + (report.built.manifestDigest ?? '').slice(0, 12) : 'BUILD FAILED') +
    '; ' + report.runs + ' runs; golden ' + (report.golden.length - failed.length) + '/' + report.golden.length);
  for (const d of report.built.diagnostics.slice(0, 40)) console.log('  ' + d.code + ' ' + d.path + ' — ' + d.message);
  for (const f of failed) console.log('  GOLDEN ' + f.frameworkId + ' ' + f.checkpoint + ' expected ' + f.expected + ' got ' + f.actual);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? 'check';
  let ok = true;
  if (command === 'check' || command === 'build') {
    for (const id of await executablePackIds()) {
      const report = await buildAndVerify(id);
      printReport(report);
      if (!report.built.valid || report.golden.some(g => !g.passed)) { ok = false; continue; }
      if (command === 'build') { const r = await publishLocal(report); console.log('  release ' + r.releaseId + ' ' + r.manifestDigest.slice(0, 12) + ' (' + r.status + ')'); }
    }
    if (command === 'build' && ok) { const catalog = await writePublicTree(); console.log('public catalog: ' + catalog.packs.length + ' packs, ' + catalog.unavailable.length + ' unavailable'); }
  } else if (command === 'public') {
    const catalog = await writePublicTree();
    console.log('public catalog: ' + catalog.packs.length + ' packs');
  } else if (command === 'sign') {
    const key = process.env.LM_RELEASE_SIGNING_KEY, keyId = process.env.LM_RELEASE_KEY_ID;
    if (!key || !keyId) throw Error('Set LM_RELEASE_SIGNING_KEY (private JWK) and LM_RELEASE_KEY_ID');
    console.log('signed ' + await signCurrent(key, keyId) + ' release(s)');
  } else throw Error('Unknown command ' + command);
  if (!ok) process.exit(1);
  void join;
}
