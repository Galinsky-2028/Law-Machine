import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import pg from 'pg';
import { PostgresLeaseClient, type DurableLease } from '../../../../jobs/src/postgres-lease-client.ts';
import { canonicalDigest, canonicalJSON } from '../../../../../packages/contracts/src/integrity.ts';
import type { AuthoredPack } from '../../../../../packages/contracts/src/pack.ts';
import { importText } from '../../../../../packages/legislation/src/import-text.ts';
import { buildPackRelease, provisionPaths } from '../../../../../packages/legislation/src/pack-builder.ts';
import { normalizeSource, parseStoredSource, serializeSource, type NormalizedDocument } from '../../../../../packages/legislation/src/provision-tree.ts';
import { diffSourceVersions } from '../../../../../packages/legislation/src/version-diff.ts';
import { checkGolden, runPackScenario, type PackRun } from '../../../../../packages/simulation/src/index.ts';
import { AI_LIMITS, extractCandidates, selectProvider } from './ai.ts';
import { authPool } from './auth.ts';
import { openSource, sealSource } from './authoring.ts';
import { fetchOfficialSource } from './official-fetch.ts';
import { purgeSaved } from './saved.ts';
import { logEvent } from './telemetry.ts';

/**
 * LM-046 durable job runner. Runs inside the web service by default and can run
 * as a separate process (scripts/worker.ts) without changing handlers. Work is
 * claimed with fenced leases; results are written only by the current lease
 * holder; every handler is idempotent so a crash or duplicate delivery is safe.
 */
type Scoped = <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
export class JobFailure extends Error { constructor(readonly code: string, readonly retryable: boolean) { super(code); } }
const LEASE_SECONDS = 30;
let pool: pg.Pool | null = null;
function workerPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, statement_timeout: 60000, application_name: 'law-machine-worker' });
    pool.on('error', () => undefined);
  }
  return pool;
}
function scopedFor(org: string): Scoped {
  return async fn => {
    const client = await workerPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id',$1,true)", [org]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  };
}
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const sourceVersion = (sourceId: string) => 'src-' + sourceId;

async function loadSource(scoped: Scoped, org: string, sourceId: string) {
  const row = await scoped(async c => (await c.query(`SELECT s.id, s.document_id, s.byte_digest, s.name, s.format, s.supersedes, s.normalized, s.official_url, o.envelope
    FROM lm_sources s JOIN lm_source_objects o ON o.org_id=s.org_id AND o.source_id=s.id WHERE s.id=$1`, [sourceId])).rows[0]);
  if (!row) throw new JobFailure('SOURCE_NOT_FOUND', false);
  return { ...row, bytes: openSource(org, sourceId, row.byte_digest, Buffer.from(row.envelope)) };
}

async function handleImport(org: string, scoped: Scoped, input: Record<string, unknown>) {
  const sourceId = String(input.sourceId ?? '');
  const source = await loadSource(scoped, org, sourceId);
  let normalized: NormalizedDocument;
  try { normalized = normalizeSource(sourceVersion(sourceId), await importText(source.bytes, { format: source.format === 'markdown' ? 'markdown' : 'text', name: source.name })); }
  catch (e) {
    await scoped(c => c.query("UPDATE lm_sources SET quarantine_state='rejected' WHERE id=$1", [sourceId]));
    throw new JobFailure('IMPORT_' + String((e as Error).message).replace(/[^A-Z0-9_]/g, '').slice(0, 40), false);
  }
  const paths = provisionPaths(normalized.provisions);
  const provisions = normalized.provisions.map(p => ({ path: paths.get(p.id)!.path, citation: paths.get(p.id)!.citation, text: p.text }));
  let impact: unknown = null;
  if (source.supersedes) {
    const previous = await scoped(async c => (await c.query('SELECT normalized FROM lm_sources WHERE id=$1', [source.supersedes])).rows[0]?.normalized);
    if (previous) {
      const before = parseStoredSource(JSON.stringify(previous));
      const beforePaths = provisionPaths(before.provisions);
      const byPath = new Map(before.provisions.map(p => [beforePaths.get(p.id)!.path, p.id]));
      const correspondence = normalized.provisions.flatMap(p => { const b = byPath.get(paths.get(p.id)!.path); return b ? [{ beforeId: b, afterId: p.id, confidence: 'provisional' as const }] : []; });
      const diff = diffSourceVersions(before, normalized, correspondence);
      const pathOf = (id: string | null, which: 'before' | 'after') => id === null ? null : which === 'before' ? beforePaths.get(id)?.path ?? null : paths.get(id)?.path ?? null;
      const changed = diff.changes.filter(c => c.category !== 'corresponded' || c.differences.includes('TEXT_CHANGED'))
        .map(c => ({ category: c.category, before: pathOf(c.beforeId, 'before'), after: pathOf(c.afterId, 'after'), differences: c.differences }));
      const payload = await scoped(async c => (await c.query(`SELECT r.payload FROM lm_documents d JOIN lm_revisions r ON r.org_id=d.org_id AND r.document_id=d.id AND r.revision=d.revision WHERE d.id=$1`, [source.document_id])).rows[0]?.payload as AuthoredPack | undefined);
      const affectedPaths = new Set(changed.flatMap(c => [c.before, c.after]).filter((x): x is string => !!x));
      const stale = (payload?.frameworks ?? []).flatMap(f => f.rules.filter(r => r.sourceRefs.some(ref => affectedPaths.has(ref.provision))).map(r => ({ framework: f.id, rule: r.id })));
      impact = { supersedes: source.supersedes, status: diff.status, changed, staleRules: stale, note: 'Rules citing changed provisions must be re-checked; nothing was republished automatically.' };
    }
  }
  await scoped(c => c.query("UPDATE lm_sources SET normalized=$2, quarantine_state='reviewed' WHERE id=$1", [sourceId, JSON.parse(serializeSource(normalized))]));
  return { sourceId, provisionCount: provisions.length, diagnostics: normalized.diagnostics.slice(0, 50), provisions: provisions.slice(0, 400).map(p => ({ ...p, text: p.text.slice(0, 600) })), impact };
}

async function handleValidate(org: string, scoped: Scoped, jobId: string, documentId: string, input: Record<string, unknown>) {
  const revision = Number(input.revision);
  const doc = await scoped(async c => (await c.query(`SELECT r.payload, p.pack_id FROM lm_revisions r JOIN lm_packs p ON p.org_id=r.org_id AND p.document_id=r.document_id WHERE r.document_id=$1 AND r.revision=$2`, [documentId, revision])).rows[0]);
  if (!doc) throw new JobFailure('REVISION_NOT_FOUND', false);
  const existing = await scoped(async c => (await c.query("SELECT id, valid, manifest_digest FROM lm_validation_reports WHERE document_id=$1 AND revision=$2 AND report->>'jobId'=$3", [documentId, revision, jobId])).rows[0]);
  if (existing) return { reportId: existing.id, valid: existing.valid, manifestDigest: existing.manifest_digest, resumed: true };
  const payload = doc.payload as AuthoredPack;
  const bytes = new Map<string, Uint8Array>();
  const missing: string[] = [];
  for (const s of payload.sources ?? []) {
    if (!s?.objectId) { missing.push(s?.id ?? '?'); continue; }
    try { bytes.set(s.id, (await loadSource(scoped, org, s.objectId)).bytes); } catch { missing.push(s.id); }
  }
  const built = missing.length ? null : await buildPackRelease(payload, bytes);
  const diagnostics = missing.length ? missing.map(id => ({ code: 'SOURCE_OBJECT_MISSING', path: '$.sources.' + id, message: 'Upload this source and set its objectId' })) : built!.diagnostics.slice(0, 200);
  const golden: { frameworkId: string; checkpoint: string; passed: boolean; expected: string; actual: string; reasoning: string }[] = [];
  if (built?.release) for (const scenario of built.release.scenarios) {
    const runs: Record<string, PackRun> = {};
    for (const f of built.release.frameworks) runs[f.id] = runPackScenario(built.release, f.id, scenario);
    golden.push(...checkGolden(built.release, scenario, runs).map(g => ({ ...g, checkpoint: scenario.id + ':' + g.checkpoint })));
  }
  const failedGolden = golden.filter(g => !g.passed);
  const valid = !!built?.valid && failedGolden.length === 0 && (built.release?.scenarios.length ?? 0) > 0;
  const manifestDigest = valid ? built!.manifestDigest! : null;
  const report = { jobId, packId: doc.pack_id, diagnostics, golden: { total: golden.length, failed: failedGolden.slice(0, 100) },
    coverage: built?.release?.coverage.map(c => ({ frameworkId: c.frameworkId, statement: c.statement })) ?? [],
    scenarios: built?.release?.scenarios.length ?? 0, ...(valid ? {} : { reason: built?.release && !built.release.scenarios.length ? 'A publishable pack needs at least one scenario with independent expectations.' : undefined }) };
  const reportId = randomUUID();
  await scoped(async c => {
    await c.query('INSERT INTO lm_validation_reports(org_id,id,document_id,revision,valid,manifest_digest,report) VALUES ($1,$2,$3,$4,$5,$6,$7)', [org, reportId, documentId, revision, valid, manifestDigest, report]);
    if (!valid) return;
    await c.query("INSERT INTO lm_audit(org_id,document_id,revision,actor_id,action) SELECT $1,$2,$3,coalesce(created_by,'00000000-0000-0000-0000-000000000000'),'validated' FROM lm_jobs WHERE id=$4", [org, documentId, revision, jobId]);
    const prior = (await c.query('SELECT id, status, revision FROM lm_releases WHERE manifest_digest=$1', [manifestDigest])).rows[0];
    if (prior?.status === 'staged' && Number(prior.revision) !== revision) await c.query('UPDATE lm_releases SET revision=$2 WHERE id=$1', [prior.id, revision]);
    if (!prior) {
      await c.query("INSERT INTO lm_releases(org_id,id,document_id,revision,manifest_digest,status,pack_id,label) VALUES ($1,$2,$3,$4,$5,'staged',$6,$7)",
        [org, randomUUID(), documentId, revision, manifestDigest, doc.pack_id, built!.manifest!.label]);
      await c.query('INSERT INTO lm_release_assets(manifest_digest,path,bytes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [manifestDigest, 'manifest.json', Buffer.from(canonicalJSON(built!.manifest))]);
      for (const [path, data] of built!.assets) await c.query('INSERT INTO lm_release_assets(manifest_digest,path,bytes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [manifestDigest, path, Buffer.from(data)]);
    }
  });
  return { reportId, valid, manifestDigest, diagnostics: diagnostics.length, goldenFailed: failedGolden.length };
}

async function handleAi(org: string, scoped: Scoped, jobId: string, documentId: string, input: Record<string, unknown>) {
  const provider = selectProvider();
  if (!provider) throw new JobFailure('AI_DISABLED', false);
  const recent = await scoped(async c => Number((await c.query("SELECT count(*) AS n FROM lm_jobs WHERE kind='ai-extract' AND created_at > now()-interval '1 day'")).rows[0]!.n));
  if (recent > AI_LIMITS.perOrgPerDay) throw new JobFailure('AI_DAILY_BUDGET_EXCEEDED', false);
  const sourceId = String(input.sourceId ?? '');
  const row = await scoped(async c => (await c.query('SELECT normalized FROM lm_sources WHERE id=$1', [sourceId])).rows[0]);
  if (!row?.normalized) throw new JobFailure('SOURCE_NOT_PARSED', false);
  const doc = parseStoredSource(JSON.stringify(row.normalized));
  const paths = provisionPaths(doc.provisions);
  const provisions = doc.provisions.map(p => ({ path: paths.get(p.id)!.path, citation: paths.get(p.id)!.citation, text: p.text }));
  const inputDigest = await canonicalDigest({ provider: provider.id, model: provider.model, provisions });
  let result;
  try { result = await extractCandidates(provider, provisions); }
  catch (e) { throw new JobFailure(String((e as Error).message).startsWith('AI_') ? String((e as Error).message) : 'AI_PROVIDER_FAILED', true); }
  const outputDigest = await canonicalDigest(result.candidates);
  await scoped(async c => {
    if ((await c.query('SELECT 1 FROM lm_ai_candidates WHERE job_id=$1', [jobId])).rowCount) return;
    for (const candidate of result.candidates)
      await c.query('INSERT INTO lm_ai_candidates(org_id,id,document_id,job_id,provider,model,input_digest,output_digest,candidate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [org, randomUUID(), documentId, jobId, result.provider, result.model, inputDigest, outputDigest, { ...candidate, sourceObjectId: sourceId }]);
  });
  return { provider: result.provider, model: result.model, candidates: result.candidates.length, dropped: result.dropped };
}

async function handleRefresh(org: string, scoped: Scoped, documentId: string, input: Record<string, unknown>) {
  const sourceId = String(input.sourceId ?? '');
  const source = await scoped(async c => (await c.query('SELECT id, byte_digest, name, format, official_url FROM lm_sources WHERE id=$1', [sourceId])).rows[0]);
  if (!source?.official_url) throw new JobFailure('SOURCE_HAS_NO_OFFICIAL_URL', false);
  let fetched;
  try { fetched = await fetchOfficialSource(source.official_url); }
  catch (e) {
    const code = String((e as Error).message).replace(/[^A-Z0-9_]/g, '').slice(0, 40) || 'SOURCE_FETCH_FAILED';
    // A failed refresh keeps the last valid snapshot with its original date.
    throw new JobFailure(code, !['SOURCE_URL_UNTRUSTED', 'OFFICIAL_DNS_NOT_PUBLIC', 'SOURCE_REDIRECT_REJECTED', 'SOURCE_TOO_LARGE'].includes(code));
  }
  const digest = sha(fetched.bytes);
  if (digest === source.byte_digest) return { changed: false, checkedAt: fetched.retrievedAt };
  const newId = randomUUID();
  const jobId = await scoped(async c => {
    const exists = (await c.query('SELECT id FROM lm_sources WHERE byte_digest=$1', [digest])).rows[0];
    if (exists) return null;
    await c.query(`INSERT INTO lm_sources(org_id,id,document_id,byte_digest,bytes_count,quarantine_state,storage_key,name,format,official_url,retrieved_at,supersedes)
      VALUES ($1,$2,$3,$4,$5,'pending','db:lm_source_objects',$6,$7,$8,$9,$10)`, [org, newId, documentId, digest, fetched.bytes.byteLength, source.name, source.format, source.official_url, fetched.retrievedAt, sourceId]);
    await c.query('INSERT INTO lm_source_objects(org_id,source_id,envelope) VALUES ($1,$2,$3)', [org, newId, sealSource(org, newId, digest, fetched.bytes)]);
    return (await c.query('SELECT lm_enqueue_job_input($1,$2,$3,$4,$5,$6,$7,$8) AS id', [org, randomUUID(), documentId, 'source-import', 'import:' + digest, 3, { sourceId: newId }, null])).rows[0]!.id;
  });
  return { changed: true, newSourceId: jobId ? newId : null, importJobId: jobId, retrievedAt: fetched.retrievedAt, note: 'A new candidate version was stored. The published release is unchanged until an editor revises, validates and publishes.' };
}

async function run(org: string, lease: DurableLease, client: PostgresLeaseClient, workerId: string) {
  const scoped = scopedFor(org);
  const job = await scoped(async c => (await c.query('SELECT input FROM lm_jobs WHERE id=$1', [lease.id])).rows[0]);
  const input = (job?.input ?? {}) as Record<string, unknown>;
  const heartbeat = setInterval(() => { void client.heartbeat(lease, LEASE_SECONDS).catch(() => undefined); }, 10000);
  const started = Date.now();
  try {
    const result = lease.kind === 'source-import' ? await handleImport(org, scoped, input)
      : lease.kind === 'release-validate' ? await handleValidate(org, scoped, lease.id, lease.documentId, input)
      : lease.kind === 'ai-extract' ? await handleAi(org, scoped, lease.id, lease.documentId, input)
      : lease.kind === 'source-refresh' ? await handleRefresh(org, scoped, lease.documentId, input)
      : (() => { throw new JobFailure('JOB_KIND_UNSUPPORTED', false); })();
    const stored = await scoped(async c => (await c.query('SELECT lm_job_set_result($1,$2,$3,$4,$5) AS ok', [org, lease.id, workerId, lease.fence.toString(), result])).rows[0]!.ok);
    if (!stored) throw new JobFailure('LEASE_LOST', true);
    await client.complete(lease, await canonicalDigest(result));
    logEvent('job.completed', { jobId: lease.id, jobKind: lease.kind, organizationId: org, durationMs: Date.now() - started, attempt: lease.attempts });
  } catch (error) {
    const failure = error instanceof JobFailure ? error : new JobFailure('JOB_INTERNAL_ERROR', true);
    await scoped(c => c.query('SELECT lm_job_set_result($1,$2,$3,$4,$5)', [org, lease.id, workerId, lease.fence.toString(), { error: failure.code }])).catch(() => undefined);
    await client.fail(lease, failure.code, failure.retryable).catch(() => undefined);
    logEvent('job.failed', { jobId: lease.id, jobKind: lease.kind, organizationId: org, code: failure.code, attempt: lease.attempts }, 'warn');
  } finally { clearInterval(heartbeat); }
}

export async function runWorkerOnce(workerId = 'web-' + hostname().slice(0, 40) + '-' + process.pid, maxJobs = 5): Promise<number> {
  const auth = authPool();
  if (!auth || !process.env.DATABASE_URL) return 0;
  const orgs = (await auth.query('SELECT id FROM lm_organizations ORDER BY id')).rows.map(r => String(r.id));
  let processed = 0;
  await purgeSaved().catch(() => 0);
  for (const org of orgs) {
    const client = new PostgresLeaseClient(workerPool() as never, { orgId: org, serverVerified: true });
    await client.reapExhausted().catch(() => undefined);
    for (let i = 0; i < maxJobs; i++) {
      const lease = await client.claim(workerId, LEASE_SECONDS);
      if (!lease) break;
      await run(org, lease, client, workerId);
      processed++;
    }
  }
  return processed;
}
let timer: NodeJS.Timeout | null = null;
export function startWorker(intervalMs = 3000): void {
  if (timer || !process.env.DATABASE_URL || !process.env.AUTH_DATABASE_URL || process.env.LM_WORKER === 'off') return;
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    runWorkerOnce().catch(error => logEvent('worker.tick_failed', { code: String((error as Error)?.message ?? 'UNKNOWN').slice(0, 60) }, 'error')).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  logEvent('worker.started', { mode: 'in-process' });
}
