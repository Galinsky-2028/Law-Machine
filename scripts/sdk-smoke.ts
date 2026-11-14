import { readFileSync } from 'node:fs';
import { loadPublicRelease, SDK_ENGINE_VERSION } from '../packages/sdk/src/index.ts';
import { canonicalDigest, sha256Hex } from '../packages/contracts/src/index.ts';

const model=JSON.parse(readFileSync(new URL('../packages/contracts/fixtures/v1-hypothetical.json',import.meta.url),'utf8')) as {
  billVersions:{id:string;sourceDigest:string}[];
  provisions:{versionId:string;source:{sourceDigest:string}}[];
  rules:{versionId:string;sourceRefs:{sourceDigest:string}[]}[];
  traces:{sourceRefs:{sourceDigest:string}[]}[];
  releases:{billVersionId:string;sourceDigest:string}[];
};
const originalBytes=new TextEncoder().encode('CLI synthetic source example\n');
const digest=await sha256Hex(originalBytes);
model.billVersions.find(v=>v.id==='v1')!.sourceDigest=digest;
for(const p of model.provisions.filter(p=>p.versionId==='v1'))p.source.sourceDigest=digest;
for(const r of model.rules.filter(r=>r.versionId==='v1'))for(const s of r.sourceRefs)s.sourceDigest=digest;
for(const t of model.traces)for(const s of t.sourceRefs)s.sourceDigest=digest;
model.releases.find(r=>r.billVersionId==='v1')!.sourceDigest=digest;
const manifest={schemaVersion:'1.0.0' as const,releaseId:'rel1',sourceDigest:digest,assets:[]};
const result=await loadPublicRelease({bundle:model,releaseId:'rel1',manifest,requestedEngineVersion:SDK_ENGINE_VERSION,
  expectedManifestDigest:await canonicalDigest(manifest),originalSourceBytes:originalBytes,assets:new Map()});
if(!result.ok)throw new Error('Headless SDK smoke failed: '+result.error.code);
const found=result.value.getProvision('p1');
if(!found.ok || found.value.text!=='Toy requirement')throw new Error('Headless SDK cannot resolve pinned toy provision');
const unavailable=result.value.simulate('s1');
if(unavailable.ok || unavailable.error.code!=='UNSUPPORTED_FEATURE')throw new Error('Headless SDK falsely reports simulation');
console.log('Headless SDK: source-verified fictional release and pinned provision lookup pass; simulation explicitly unavailable.');

// LM-059: a separate headless consumer loads a published pack release through the fetch path.
import { fetchPackRelease } from '../packages/sdk/src/index.ts';
import { readFile as readPublished } from 'node:fs/promises';
const publicRoot = new URL('../apps/web/public/releases/', import.meta.url);
const catalog = JSON.parse(await readPublished(new URL('catalog.json', publicRoot), 'utf8')) as { packs: { packId: string; current: string }[] };
const trust = JSON.parse(await readPublished(new URL('trust.json', publicRoot), 'utf8'));
const fileFetch = async (url: string) => {
  try { const bytes = await readPublished(new URL(url.replace(/^releases\//, ''), publicRoot)); return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }; }
  catch { return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; }
};
for (const entry of catalog.packs) {
  // A separate consumer (e.g. a future Ask Bill client) insists on a trusted publisher signature.
  const session = await fetchPackRelease('releases', entry.packId, entry.current, { fetch: fileFetch, trust, requireSignature: trust.keys.length > 0 });
  const first = session.release.scenarios[0]!;
  const { run } = session.runScenario(first.id);
  const legal = run.events.find(e => e.basis === 'legal')!;
  const why = session.getTraceExplanation(run, legal.id);
  if (!why.excerpts.length || why.excerpts.some(x => x.stale)) throw new Error('Headless SDK could not resolve a pinned citation for ' + entry.packId);
  const cited = session.resolveCitation(legal.sourceRefs[0]!);
  if (cited.status !== 'resolved') throw new Error('Pinned anchor did not resolve for ' + entry.packId);
  const focus = session.getSceneFocusTarget({ kind: 'actor', id: legal.actorId }, run);
  if (!focus.found || !focus.eventIds.length) throw new Error('Semantic focus target missing for ' + entry.packId);
  if (!session.search(session.release.glossary[0]?.term ?? session.release.title).length) throw new Error('Search returned nothing for ' + entry.packId);
  console.log('Headless SDK: ' + entry.packId + ' ' + entry.current.slice(0, 12) + ' verified (' + (session.signature.valid ? 'signed ' + session.signature.keyId : 'unsigned: ' + session.signature.reason) + '); ' + first.id + ' ran ' + run.events.length + ' events.');
}
