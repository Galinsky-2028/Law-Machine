import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonicalDigest, canonicalJSON } from '../../../../../packages/contracts/src/integrity.ts';
import type { AuthoredPack, CatalogPack, PackRelease } from '../../../../../packages/contracts/src/pack.ts';
import { signManifest } from '../../../../../packages/contracts/src/signing.ts';
import type { AuthorContext } from '../author-auth.ts';
import { database, type Tx } from './db.ts';
import { currentPackIds } from './releases.ts';
import { logEvent } from './telemetry.ts';

/** LM-044..LM-047 tenant-scoped authoring store on the lm_app role. */
export class AuthoringError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const MAX_SOURCE_BYTES = 2_000_000;

function db() {
  const d = database();
  if (!d) throw new AuthoringError(503, 'AUTHORING_DISABLED');
  return d;
}
const inOrg = <T>(ctx: Pick<AuthorContext, 'organizationId' | 'subject'>, fn: (tx: Tx) => Promise<T>) => db().inOrganization(ctx.organizationId, fn, ctx.subject);
function sourceKey(): Buffer {
  const raw = process.env.LM_SOURCE_KEY;
  const key = raw ? Buffer.from(raw, 'base64') : null;
  if (!key || key.length !== 32) throw new AuthoringError(503, 'SOURCE_STORAGE_KEY_MISSING');
  return key;
}
/** AES-256-GCM envelope bound to tenant, source and digest so rows cannot be swapped. */
export function sealSource(org: string, sourceId: string, digest: string, bytes: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sourceKey(), nonce);
  cipher.setAAD(Buffer.from(org + '/' + sourceId + '/' + digest));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from('LMS1'), nonce, cipher.getAuthTag(), body]);
}
export function openSource(org: string, sourceId: string, digest: string, envelope: Buffer): Uint8Array {
  if (envelope.length < 32 || envelope.subarray(0, 4).toString() !== 'LMS1') throw new AuthoringError(500, 'SOURCE_ENVELOPE_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', sourceKey(), envelope.subarray(4, 16));
  decipher.setAAD(Buffer.from(org + '/' + sourceId + '/' + digest));
  decipher.setAuthTag(envelope.subarray(16, 32));
  const bytes = new Uint8Array(Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()]));
  if (sha(bytes) !== digest) throw new AuthoringError(500, 'SOURCE_DIGEST_MISMATCH');
  return bytes;
}

export function starterPack(packId: string, title: string): AuthoredPack {
  return {
    format: 'law-machine-pack-v1', packId, title, question: 'What question does this model answer?', summary: 'Describe what this model covers.', domain: 'institutional-process', fictional: true,
    disclaimers: ['This model is a draft. State whether its law is fictional or sourced, and its limits.'], releaseLabel: '0.1.0', releasedAt: new Date().toISOString().slice(0, 10),
    sources: [], actors: [], facts: [], calendars: [{ id: 'civil', version: '1', timeZone: 'UTC', weekendDays: [0, 6], observedHolidays: [], basis: 'Assumption: business days are Monday to Friday; no holidays listed.' }],
    deadlines: [], frameworks: [], interpretations: [], assumptions: [], scenarios: [],
    scene: { id: 'map', title: 'Who is involved', width: 760, height: 460, groups: [], nodes: [], edges: [] }, glossary: [], explanations: {}, eventLabels: {}
  };
}

export async function listPacks(ctx: AuthorContext) {
  return inOrg(ctx, async tx => (await tx.query(`SELECT p.pack_id, d.id, d.revision, d.updated_at, r.payload->>'title' AS title,
      (SELECT valid FROM lm_validation_reports v WHERE v.org_id=d.org_id AND v.document_id=d.id AND v.revision=d.revision ORDER BY created_at DESC LIMIT 1) AS valid,
      (SELECT manifest_digest FROM lm_publication_pointers pp WHERE pp.pack_id=p.pack_id) AS published
    FROM lm_packs p JOIN lm_documents d ON d.org_id=p.org_id AND d.id=p.document_id
    JOIN lm_revisions r ON r.org_id=d.org_id AND r.document_id=d.id AND r.revision=d.revision ORDER BY d.updated_at DESC`)).rows
    .map(r => ({ documentId: r.id as string, packId: r.pack_id as string, title: r.title as string, revision: Number(r.revision), updatedAt: new Date(r.updated_at).toISOString(), valid: r.valid as boolean | null, published: r.published as string | null })));
}
export async function createPack(ctx: AuthorContext, input: { packId?: unknown; title?: unknown }) {
  const packId = typeof input.packId === 'string' ? input.packId.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
  if (!PACK_ID.test(packId) || !title) throw new AuthoringError(400, 'PACK_ID_OR_TITLE_INVALID');
  if (currentPackIds().includes(packId)) throw new AuthoringError(409, 'PACK_ID_TAKEN');
  const payload = starterPack(packId, title);
  const documentId = randomUUID();
  try {
    await inOrg(ctx, async tx => {
      await tx.query('SELECT lm_create_document($1,$2,$3,$4,$5)', [ctx.organizationId, documentId, ctx.subject, payload, await canonicalDigest(payload)]);
      await tx.query('INSERT INTO lm_packs(org_id, document_id, pack_id) VALUES ($1,$2,$3)', [ctx.organizationId, documentId, packId]);
    });
  } catch (e) { if (String((e as Error).message).includes('lm_packs_pack_id_key')) throw new AuthoringError(409, 'PACK_ID_TAKEN'); throw e; }
  return { documentId, packId, revision: 1 };
}
export async function getPack(ctx: AuthorContext, documentId: string) {
  if (!UUID.test(documentId)) throw new AuthoringError(404, 'NOT_FOUND');
  return inOrg(ctx, async tx => {
    const doc = (await tx.query(`SELECT d.revision, p.pack_id, r.payload, r.created_at FROM lm_documents d JOIN lm_packs p ON p.org_id=d.org_id AND p.document_id=d.id
      JOIN lm_revisions r ON r.org_id=d.org_id AND r.document_id=d.id AND r.revision=d.revision WHERE d.id=$1`, [documentId])).rows[0];
    if (!doc) throw new AuthoringError(404, 'NOT_FOUND');
    const sources = (await tx.query(`SELECT id, name, format, byte_digest, bytes_count, quarantine_state, official_url, retrieved_at, created_at, supersedes,
      normalized IS NOT NULL AS parsed FROM lm_sources WHERE document_id=$1 ORDER BY created_at`, [documentId])).rows;
    const jobs = (await tx.query(`SELECT id, kind, state, attempts, last_error_code, created_at, updated_at, result FROM lm_jobs WHERE document_id=$1 ORDER BY created_at DESC LIMIT 20`, [documentId])).rows;
    const validations = (await tx.query(`SELECT id, revision, valid, manifest_digest, report, created_at FROM lm_validation_reports WHERE document_id=$1 ORDER BY created_at DESC LIMIT 10`, [documentId])).rows;
    const releases = (await tx.query(`SELECT id, revision, manifest_digest, status, label, published_at, withdrawn_at, note, signature IS NOT NULL AS signed FROM lm_releases WHERE document_id=$1 ORDER BY created_at DESC`, [documentId])).rows;
    const pointer = (await tx.query('SELECT manifest_digest, release_uuid, updated_at FROM lm_publication_pointers WHERE pack_id=$1', [doc.pack_id])).rows[0] ?? null;
    const history = (await tx.query(`SELECT a.revision, a.action, a.at, coalesce(x.display_name,'Author') AS actor FROM lm_audit a LEFT JOIN lm_actors x ON x.id=a.actor_id
      WHERE a.document_id=$1 ORDER BY a.id DESC LIMIT 30`, [documentId])).rows;
    return { documentId, packId: doc.pack_id as string, revision: Number(doc.revision), payload: doc.payload as AuthoredPack, sources, jobs, validations, releases, pointer, history };
  });
}
/** Optimistic concurrency: a stale expected revision never overwrites a newer one. */
export async function savePack(ctx: AuthorContext, documentId: string, expectedRevision: unknown, payload: unknown) {
  if (!UUID.test(documentId) || !Number.isSafeInteger(expectedRevision)) throw new AuthoringError(400, 'REQUEST_INVALID');
  const text = canonicalJSON(payload);
  if (text.length > 1_900_000) throw new AuthoringError(413, 'PAYLOAD_TOO_LARGE');
  const p = payload as AuthoredPack;
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.format !== 'law-machine-pack-v1') throw new AuthoringError(400, 'PACK_FORMAT_INVALID');
  return inOrg(ctx, async tx => {
    const packId = (await tx.query('SELECT pack_id FROM lm_packs WHERE document_id=$1', [documentId])).rows[0]?.pack_id;
    if (!packId) throw new AuthoringError(404, 'NOT_FOUND');
    if (p.packId !== packId) throw new AuthoringError(400, 'PACK_ID_IMMUTABLE');
    try {
      const revision = (await tx.query('SELECT lm_update_document($1,$2,$3,$4,$5,$6) AS r', [ctx.organizationId, documentId, ctx.subject, expectedRevision, JSON.parse(text), await canonicalDigest(payload)])).rows[0]!.r;
      return { revision: Number(revision) };
    } catch (e) {
      if (String((e as Error).message).includes('LM_STALE_REVISION')) throw new AuthoringError(409, 'STALE_REVISION');
      throw e;
    }
  });
}

/** Bounded upload into encrypted private storage. Parsing happens later in a job, never in the request. */
export async function importSource(ctx: AuthorContext, documentId: string, input: { name: string; format: 'text' | 'markdown'; bytes: Uint8Array; officialUrl?: string | null }) {
  if (!UUID.test(documentId)) throw new AuthoringError(404, 'NOT_FOUND');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_SOURCE_BYTES) throw new AuthoringError(413, 'SOURCE_SIZE_INVALID');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}$/.test(input.name) || !['text', 'markdown'].includes(input.format)) throw new AuthoringError(400, 'SOURCE_METADATA_INVALID');
  if (input.officialUrl != null) {
    try { const u = new URL(input.officialUrl); if (u.protocol !== 'https:' || u.username || u.password) throw Error(); } catch { throw new AuthoringError(400, 'OFFICIAL_URL_INVALID'); }
  }
  const digest = sha(input.bytes);
  return inOrg(ctx, async tx => {
    if (!(await tx.query('SELECT 1 FROM lm_packs WHERE document_id=$1', [documentId])).rowCount) throw new AuthoringError(404, 'NOT_FOUND');
    const existing = (await tx.query('SELECT id, document_id FROM lm_sources WHERE byte_digest=$1', [digest])).rows[0];
    const sourceId = existing?.id ?? randomUUID();
    if (!existing) {
      await tx.query(`INSERT INTO lm_sources(org_id,id,document_id,byte_digest,bytes_count,quarantine_state,storage_key,name,format,official_url,created_by)
        VALUES ($1,$2,$3,$4,$5,'pending','db:lm_source_objects',$6,$7,$8,$9)`, [ctx.organizationId, sourceId, documentId, digest, input.bytes.byteLength, input.name, input.format, input.officialUrl ?? null, ctx.subject]);
      await tx.query('INSERT INTO lm_source_objects(org_id,source_id,envelope) VALUES ($1,$2,$3)', [ctx.organizationId, sourceId, sealSource(ctx.organizationId, sourceId, digest, input.bytes)]);
    }
    const jobId = (await tx.query('SELECT lm_enqueue_job_input($1,$2,$3,$4,$5,$6,$7,$8) AS id', [ctx.organizationId, randomUUID(), existing?.document_id ?? documentId, 'source-import', 'import:' + digest, 3, { sourceId }, ctx.subject])).rows[0]!.id;
    logEvent('author.source.imported', { organizationId: ctx.organizationId, jobId, kind: existing ? 'duplicate' : 'new' });
    return { sourceId, jobId: jobId as string, duplicate: !!existing, digest };
  });
}
export async function enqueue(ctx: AuthorContext, documentId: string, kind: 'release-validate' | 'ai-extract' | 'source-refresh', idempotency: string, input: Record<string, unknown>) {
  return inOrg(ctx, async tx => {
    if (!(await tx.query('SELECT 1 FROM lm_packs WHERE document_id=$1', [documentId])).rowCount) throw new AuthoringError(404, 'NOT_FOUND');
    return (await tx.query('SELECT lm_enqueue_job_input($1,$2,$3,$4,$5,$6,$7,$8) AS id', [ctx.organizationId, randomUUID(), documentId, kind, idempotency.slice(0, 128), 3, input, ctx.subject])).rows[0]!.id as string;
  });
}
export async function requestValidation(ctx: AuthorContext, documentId: string) {
  const revision = await inOrg(ctx, async tx => Number((await tx.query('SELECT revision FROM lm_documents WHERE id=$1', [documentId])).rows[0]?.revision ?? 0));
  if (!revision) throw new AuthoringError(404, 'NOT_FOUND');
  return { jobId: await enqueue(ctx, documentId, 'release-validate', 'validate:' + documentId + ':' + revision, { revision }), revision };
}
export async function getJob(ctx: AuthorContext, jobId: string) {
  if (!UUID.test(jobId)) throw new AuthoringError(404, 'NOT_FOUND');
  const row = await inOrg(ctx, async tx => (await tx.query('SELECT id, document_id, kind, state, attempts, max_attempts, last_error_code, result, created_at, updated_at FROM lm_jobs WHERE id=$1', [jobId])).rows[0]);
  if (!row) throw new AuthoringError(404, 'NOT_FOUND');
  return row;
}
/** Private preview of a staged build: tenant-scoped, never cached, never public. */
export async function stagedBundle(ctx: AuthorContext, documentId: string, manifestDigest: string): Promise<PackRelease> {
  if (!/^[a-f0-9]{64}$/.test(manifestDigest)) throw new AuthoringError(404, 'NOT_FOUND');
  return inOrg(ctx, async tx => {
    const rel = (await tx.query('SELECT 1 FROM lm_releases WHERE document_id=$1 AND manifest_digest=$2', [documentId, manifestDigest])).rows[0];
    if (!rel) throw new AuthoringError(404, 'NOT_FOUND');
    const manifest = JSON.parse(Buffer.from((await tx.query("SELECT bytes FROM lm_release_assets WHERE manifest_digest=$1 AND path='manifest.json'", [manifestDigest])).rows[0]!.bytes).toString('utf8'));
    const bundle = (await tx.query('SELECT bytes FROM lm_release_assets WHERE manifest_digest=$1 AND path=$2', [manifestDigest, manifest.bundlePath])).rows[0];
    if (!bundle) throw new AuthoringError(404, 'NOT_FOUND');
    return JSON.parse(Buffer.from(bundle.bytes).toString('utf8')) as PackRelease;
  });
}

async function verifyAssets(tx: Tx, manifestDigest: string): Promise<{ manifest: { packId: string; label: string; releaseId: string; bundlePath: string; assets: { path: string; digest: string }[] }; bundle: PackRelease }> {
  const rows = (await tx.query('SELECT path, bytes FROM lm_release_assets WHERE manifest_digest=$1', [manifestDigest])).rows;
  const files = new Map(rows.map(r => [r.path as string, new Uint8Array(r.bytes)]));
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new AuthoringError(409, 'RELEASE_ASSETS_INCOMPLETE');
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  if (await canonicalDigest(manifest) !== manifestDigest) throw new AuthoringError(409, 'MANIFEST_DIGEST_MISMATCH');
  for (const asset of manifest.assets) {
    const bytes = files.get(asset.path);
    if (!bytes || sha(bytes) !== asset.digest) throw new AuthoringError(409, 'RELEASE_ASSET_INVALID');
  }
  return { manifest, bundle: JSON.parse(Buffer.from(files.get(manifest.bundlePath)!).toString('utf8')) as PackRelease };
}
function catalogEntry(bundle: PackRelease): Omit<CatalogPack, 'current' | 'releases'> {
  const proposal = bundle.frameworks.find(f => f.role === 'proposal') ?? bundle.frameworks[0]!;
  const baseline = bundle.frameworks.find(f => f.role === 'baseline');
  return { packId: bundle.packId, title: bundle.title, question: bundle.question, summary: bundle.summary, domain: bundle.domain, fictional: bundle.fictional,
    statusLabel: (bundle.fictional ? 'Fictional · ' : '') + ({ draft: 'Draft proposal — not enacted', introduced: 'Introduced proposal — not enacted', enacted: 'Recorded as enacted', repealed: 'Repealed' } as const)[proposal.status],
    jurisdiction: proposal.jurisdiction, baselineAsOf: baseline?.asOf ?? null, scenarioCount: bundle.scenarios.length };
}
/**
 * Atomic publication: the staged release must belong to the document's current
 * revision with a passing validation; every asset is re-hashed; then status,
 * signature and the public pointer change in one transaction.
 */
export async function publish(ctx: AuthorContext, documentId: string, releaseUuid: string) {
  if (!UUID.test(documentId) || !UUID.test(releaseUuid)) throw new AuthoringError(400, 'REQUEST_INVALID');
  const key = process.env.LM_RELEASE_SIGNING_KEY, keyId = process.env.LM_RELEASE_KEY_ID;
  return inOrg(ctx, async tx => {
    const rel = (await tx.query(`SELECT r.revision, r.manifest_digest, r.status, r.pack_id, d.revision AS current FROM lm_releases r JOIN lm_documents d ON d.org_id=r.org_id AND d.id=r.document_id
      WHERE r.id=$1 AND r.document_id=$2 FOR UPDATE OF r`, [releaseUuid, documentId])).rows[0];
    if (!rel) throw new AuthoringError(404, 'NOT_FOUND');
    if (rel.status !== 'staged') throw new AuthoringError(409, 'RELEASE_NOT_STAGED');
    if (Number(rel.revision) !== Number(rel.current)) throw new AuthoringError(409, 'VALIDATION_STALE');
    const report = (await tx.query('SELECT valid, manifest_digest FROM lm_validation_reports WHERE document_id=$1 AND revision=$2 ORDER BY created_at DESC LIMIT 1', [documentId, rel.revision])).rows[0];
    if (!report?.valid || report.manifest_digest !== rel.manifest_digest) throw new AuthoringError(409, 'VALIDATION_REQUIRED');
    if (currentPackIds().includes(rel.pack_id)) throw new AuthoringError(409, 'PACK_ID_TAKEN');
    const { manifest, bundle } = await verifyAssets(tx, rel.manifest_digest);
    if ((await tx.query("SELECT 1 FROM lm_releases WHERE pack_id=$1 AND label=$2 AND status<>'staged'", [rel.pack_id, manifest.label])).rowCount) throw new AuthoringError(409, 'RELEASE_LABEL_REUSED');
    const publishedAt = new Date().toISOString();
    const signature = key && keyId ? await signManifest(JSON.parse(key), keyId, rel.manifest_digest, publishedAt) : null;
    await tx.query(`UPDATE lm_releases SET status='published', published_at=$2, published_by=$3, signature=$4, release_id=$5, label=$6, catalog=$7 WHERE id=$1`,
      [releaseUuid, publishedAt, ctx.subject, signature, manifest.releaseId, manifest.label, catalogEntry(bundle)]);
    await tx.query(`INSERT INTO lm_publication_pointers(pack_id, org_id, release_uuid, manifest_digest, updated_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (pack_id) DO UPDATE SET release_uuid=EXCLUDED.release_uuid, manifest_digest=EXCLUDED.manifest_digest, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [rel.pack_id, ctx.organizationId, releaseUuid, rel.manifest_digest, ctx.subject]);
    await tx.query("INSERT INTO lm_audit(org_id, document_id, revision, actor_id, action) VALUES ($1,$2,$3,$4,'published')", [ctx.organizationId, documentId, rel.revision, ctx.subject]);
    logEvent('author.release.published', { organizationId: ctx.organizationId, packId: rel.pack_id, releaseId: manifest.releaseId });
    return { manifestDigest: rel.manifest_digest as string, releaseId: manifest.releaseId, signed: !!signature };
  });
}
/** Withdrawal marks the release; the pointer falls back to the newest remaining published release. */
export async function withdraw(ctx: AuthorContext, documentId: string, releaseUuid: string, note: string) {
  if (!UUID.test(documentId) || !UUID.test(releaseUuid) || typeof note !== 'string' || !note.trim() || note.length > 500) throw new AuthoringError(400, 'REQUEST_INVALID');
  return inOrg(ctx, async tx => {
    const rel = (await tx.query("UPDATE lm_releases SET status='withdrawn', withdrawn_at=now(), note=$3 WHERE id=$1 AND document_id=$2 AND status='published' RETURNING pack_id, revision", [releaseUuid, documentId, note.trim()])).rows[0];
    if (!rel) throw new AuthoringError(409, 'RELEASE_NOT_PUBLISHED');
    const fallback = (await tx.query("SELECT id, manifest_digest FROM lm_releases WHERE pack_id=$1 AND status='published' ORDER BY published_at DESC LIMIT 1", [rel.pack_id])).rows[0];
    if (fallback) await tx.query('UPDATE lm_publication_pointers SET release_uuid=$2, manifest_digest=$3, updated_at=now(), updated_by=$4 WHERE pack_id=$1', [rel.pack_id, fallback.id, fallback.manifest_digest, ctx.subject]);
    else await tx.query("UPDATE lm_publication_pointers SET updated_at=now(), updated_by=$2 WHERE pack_id=$1 AND release_uuid=$3", [rel.pack_id, ctx.subject, releaseUuid]);
    await tx.query("INSERT INTO lm_audit(org_id, document_id, revision, actor_id, action) VALUES ($1,$2,$3,$4,'withdrawn')", [ctx.organizationId, documentId, rel.revision, ctx.subject]);
    return { pointer: fallback?.manifest_digest ?? null };
  });
}
/** Rolling back the pointer restores a prior complete, published release. */
export async function restorePointer(ctx: AuthorContext, documentId: string, releaseUuid: string) {
  if (!UUID.test(documentId) || !UUID.test(releaseUuid)) throw new AuthoringError(400, 'REQUEST_INVALID');
  return inOrg(ctx, async tx => {
    const rel = (await tx.query("SELECT pack_id, manifest_digest, revision FROM lm_releases WHERE id=$1 AND document_id=$2 AND status='published'", [releaseUuid, documentId])).rows[0];
    if (!rel) throw new AuthoringError(409, 'RELEASE_NOT_PUBLISHED');
    await verifyAssets(tx, rel.manifest_digest);
    await tx.query('UPDATE lm_publication_pointers SET release_uuid=$2, manifest_digest=$3, updated_at=now(), updated_by=$4 WHERE pack_id=$1', [rel.pack_id, releaseUuid, rel.manifest_digest, ctx.subject]);
    await tx.query("INSERT INTO lm_audit(org_id, document_id, revision, actor_id, action) VALUES ($1,$2,$3,$4,'pointer-restored')", [ctx.organizationId, documentId, rel.revision, ctx.subject]);
    return { manifestDigest: rel.manifest_digest as string };
  });
}
export async function decideCandidate(ctx: AuthorContext, documentId: string, candidateId: string, disposition: 'accepted' | 'rejected') {
  if (!UUID.test(candidateId) || !['accepted', 'rejected'].includes(disposition)) throw new AuthoringError(400, 'REQUEST_INVALID');
  return inOrg(ctx, async tx => {
    const row = (await tx.query("UPDATE lm_ai_candidates SET disposition=$3, decided_by=$4, decided_at=now() WHERE id=$1 AND document_id=$2 AND disposition='pending' RETURNING candidate", [candidateId, documentId, disposition, ctx.subject])).rows[0];
    if (!row) throw new AuthoringError(409, 'CANDIDATE_ALREADY_DECIDED');
    return { candidate: row.candidate };
  });
}
export async function listCandidates(ctx: AuthorContext, documentId: string) {
  return inOrg(ctx, async tx => (await tx.query('SELECT id, provider, model, candidate, disposition, created_at FROM lm_ai_candidates WHERE document_id=$1 ORDER BY created_at DESC LIMIT 100', [documentId])).rows);
}
export async function sourceDocument(ctx: AuthorContext, sourceId: string) {
  if (!UUID.test(sourceId)) throw new AuthoringError(404, 'NOT_FOUND');
  return inOrg(ctx, async tx => {
    const row = (await tx.query('SELECT id, name, format, byte_digest, normalized, official_url, quarantine_state FROM lm_sources WHERE id=$1', [sourceId])).rows[0];
    if (!row) throw new AuthoringError(404, 'NOT_FOUND');
    return row;
  });
}
export const newId = () => randomUUID();
