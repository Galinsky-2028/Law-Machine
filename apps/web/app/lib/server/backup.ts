import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { canonicalDigest } from '../../../../../packages/contracts/src/integrity.ts';
import type { PackRelease } from '../../../../../packages/contracts/src/pack.ts';
import { checkGolden, runPackScenario, type PackRun } from '../../../../../packages/simulation/src/index.ts';
import { migrate } from './migrate.ts';

/**
 * LM-053 logical backup and isolated restore. Backups contain draft content
 * and must stay private: each archive is gzip-compressed and AES-256-GCM
 * encrypted with LM_BACKUP_KEY. Row security is relaxed only inside the
 * owner's own transaction (NO FORCE then rollback/FORCE), never persistently.
 * Signing keys are not in backups; see the runbook for key recovery or reissue.
 */
export const BACKUP_TABLES = ['lm_organizations', 'lm_actors', 'lm_memberships', 'lm_author_identities', 'lm_author_sessions', 'lm_webauthn_credentials', 'lm_invitations',
  'lm_documents', 'lm_revisions', 'lm_audit', 'lm_packs', 'lm_sources', 'lm_source_objects', 'lm_jobs', 'lm_validation_reports', 'lm_releases', 'lm_release_assets',
  'lm_publication_pointers', 'lm_ai_candidates', 'lm_saved_scenarios', 'lm_run_verifications'] as const;
type Archive = { format: 'law-machine-backup-v1'; createdAt: string; schemaVersion: number; tables: Record<string, { rows: unknown[]; count: number; sha256: string }> };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function key(raw = process.env.LM_BACKUP_KEY): Buffer {
  const k = raw ? Buffer.from(raw, 'base64') : null;
  if (!k || k.length !== 32) throw Error('LM_BACKUP_KEY must be 32 bytes, base64');
  return k;
}
async function relaxed<T>(client: pg.Client, fn: () => Promise<T>, commit: boolean): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    for (const t of BACKUP_TABLES) await client.query('ALTER TABLE ' + t + ' NO FORCE ROW LEVEL SECURITY');
    const result = await fn();
    for (const t of BACKUP_TABLES) await client.query('ALTER TABLE ' + t + ' FORCE ROW LEVEL SECURITY');
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
export async function createBackup(url: string): Promise<{ archive: Buffer; summary: Record<string, number>; createdAt: string; digest: string }> {
  const client = new pg.Client({ connectionString: url, application_name: 'law-machine-backup' });
  await client.connect();
  try {
    const createdAt = new Date().toISOString();
    const schemaVersion = Number((await client.query('SELECT max(version) AS v FROM lm_schema_migrations')).rows[0].v);
    const tables = await relaxed(client, async () => {
      const out: Archive['tables'] = {};
      for (const t of BACKUP_TABLES) {
        const rows = (await client.query('SELECT to_jsonb(x) AS r FROM ' + t + ' x')).rows.map(r => r.r);
        const text = JSON.stringify(rows);
        out[t] = { rows, count: rows.length, sha256: sha(text) };
      }
      return out;
    }, false);
    const plain = gzipSync(Buffer.from(JSON.stringify({ format: 'law-machine-backup-v1', createdAt, schemaVersion, tables } satisfies Archive)));
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), nonce);
    cipher.setAAD(Buffer.from('law-machine-backup-v1'));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const archive = Buffer.concat([Buffer.from('LMB1'), nonce, cipher.getAuthTag(), body]);
    return { archive, createdAt, digest: sha(archive.toString('base64')), summary: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.count])) };
  } finally { await client.end(); }
}
export function openBackup(archive: Buffer): Archive {
  if (archive.subarray(0, 4).toString() !== 'LMB1') throw Error('BACKUP_FORMAT_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key(), archive.subarray(4, 16));
  decipher.setAAD(Buffer.from('law-machine-backup-v1'));
  decipher.setAuthTag(archive.subarray(16, 32));
  const data = JSON.parse(gunzipSync(Buffer.concat([decipher.update(archive.subarray(32)), decipher.final()])).toString('utf8')) as Archive;
  for (const [t, v] of Object.entries(data.tables)) if (sha(JSON.stringify(v.rows)) !== v.sha256 || v.rows.length !== v.count) throw Error('BACKUP_TABLE_CORRUPT: ' + t);
  return data;
}
/** Restore into an EMPTY isolated database (never the live one), then verify content integrity and replay. */
export async function restoreBackup(archive: Buffer, url: string): Promise<{ restored: Record<string, number>; verification: Awaited<ReturnType<typeof verifyRestored>>; durationMs: number; recoveryPointAgeSeconds: number }> {
  const started = Date.now();
  const data = openBackup(archive);
  const client = new pg.Client({ connectionString: url, application_name: 'law-machine-restore' });
  await client.connect();
  try {
    const existing = (await client.query("SELECT to_regclass('public.lm_documents') IS NOT NULL AS has")).rows[0].has;
    if (existing && Number((await client.query('SELECT count(*) AS n FROM lm_documents')).rows[0].n) > 0) throw Error('RESTORE_TARGET_NOT_EMPTY');
  } finally { await client.end(); }
  await migrate({ url });
  const c2 = new pg.Client({ connectionString: url, application_name: 'law-machine-restore' });
  await c2.connect();
  const restored: Record<string, number> = {};
  try {
    const current = Number((await c2.query('SELECT max(version) AS v FROM lm_schema_migrations')).rows[0].v);
    if (current < data.schemaVersion) throw Error('RESTORE_SCHEMA_TOO_OLD');
    await relaxed(c2, async () => {
      for (const t of BACKUP_TABLES) {
        const rows = data.tables[t]?.rows ?? [];
        // json_populate_recordset keeps every column typed exactly as the live schema defines it.
        if (rows.length) await c2.query('INSERT INTO ' + t + ' OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::' + t + ', $1::jsonb)', [JSON.stringify(rows)]);
        restored[t] = rows.length;
      }
      await c2.query("SELECT setval(pg_get_serial_sequence('lm_audit','id'), coalesce((SELECT max(id) FROM lm_audit),0)+1, false)");
    }, true);
  } finally { await c2.end(); }
  const verification = await verifyRestored(url);
  return { restored, verification, durationMs: Date.now() - started, recoveryPointAgeSeconds: Math.round((Date.now() - Date.parse(data.createdAt)) / 1000) };
}
/** Re-hash every release asset against its manifest and replay each release's scenarios against their expectations. */
export async function verifyRestored(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await relaxed(client, async () => {
      const releases = (await client.query('SELECT pack_id, manifest_digest, status FROM lm_releases ORDER BY created_at')).rows;
      const results = [];
      for (const r of releases) {
        const files = new Map((await client.query('SELECT path, bytes FROM lm_release_assets WHERE manifest_digest=$1', [r.manifest_digest])).rows.map(x => [x.path as string, Buffer.from(x.bytes)]));
        const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? 'null');
        const manifestOk = !!manifest && await canonicalDigest(manifest) === r.manifest_digest;
        const assetsOk = manifestOk && manifest.assets.every((a: { path: string; digest: string }) => files.has(a.path) && createHash('sha256').update(files.get(a.path)!).digest('hex') === a.digest);
        let golden = { total: 0, failed: 0 };
        if (assetsOk) {
          const release = JSON.parse(files.get(manifest.bundlePath)!.toString('utf8')) as PackRelease;
          for (const s of release.scenarios) {
            const runs: Record<string, PackRun> = {};
            for (const f of release.frameworks) runs[f.id] = runPackScenario(release, f.id, s);
            const g = checkGolden(release, s, runs);
            golden = { total: golden.total + g.length, failed: golden.failed + g.filter(x => !x.passed).length };
          }
        }
        results.push({ packId: r.pack_id, manifestDigest: r.manifest_digest, status: r.status, manifestOk, assetsOk, golden });
      }
      const pointers = (await client.query('SELECT p.pack_id, p.manifest_digest, r.status FROM lm_publication_pointers p JOIN lm_releases r ON r.id=p.release_uuid')).rows;
      return { releases: results, pointersConsistent: pointers.every(p => p.status !== 'staged'), ok: results.every(x => x.assetsOk && x.golden.failed === 0) };
    }, false);
  } finally { await client.end(); }
}
