import { createHash, randomBytes } from 'node:crypto';
import { encodeShare } from '../../../../../packages/presentation/src/projection.ts';
import { prepareScenario } from '../../../../../packages/simulation/src/pack-analysis.ts';
import { database } from './db.ts';
import { loadPack } from './releases.ts';

/** LM-051 explicit, opt-in saved scenarios. Anonymous use stays local unless a visitor saves. */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ID = /^[A-Za-z0-9_-]{43}$/;
export class SaveError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

export async function saveScenario(body: Record<string, unknown>) {
  const db = database();
  if (!db) throw new SaveError(503, 'SERVER_SAVES_UNAVAILABLE');
  const packId = String(body.packId ?? ''), digest = String(body.manifestDigest ?? ''), scenarioId = String(body.scenarioId ?? ''), frameworkId = String(body.frameworkId ?? '');
  const days = Number(body.retentionDays ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new SaveError(400, 'RETENTION_INVALID');
  const pack = await loadPack(packId, digest).catch(() => null);
  const status = pack?.catalog.releases.find(r => r.manifestDigest === digest)?.status;
  if (!pack || pack.manifestDigest !== digest || !status) throw new SaveError(404, 'RELEASE_UNKNOWN');
  if (status === 'withdrawn') throw new SaveError(410, 'RELEASE_WITHDRAWN');
  if (!pack.release.frameworks.some(f => f.id === frameworkId) && frameworkId !== 'compare') throw new SaveError(400, 'FRAMEWORK_INVALID');
  const params = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters) ? body.parameters as Record<string, boolean | number | string | null> : {};
  let prepared;
  try { prepared = prepareScenario(pack.release, scenarioId, params); } catch { throw new SaveError(404, 'SCENARIO_UNKNOWN'); }
  if (prepared.issues.length) throw new SaveError(400, 'PARAMETERS_INVALID');
  const id = randomBytes(32).toString('base64url'), deleteToken = randomBytes(32).toString('base64url');
  const row = (await db.query(`INSERT INTO lm_saved_scenarios(id_digest,delete_digest,pack_id,manifest_digest,scenario_id,framework_id,parameters,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8)) RETURNING expires_at`, [sha(id), sha(deleteToken), packId, digest, scenarioId, frameworkId, prepared.values, days])).rows[0]!;
  return { id, deleteToken, url: '/s/' + id, expiresAt: new Date(row.expires_at).toISOString() };
}
export async function resolveSaved(id: string) {
  const db = database();
  if (!db) throw new SaveError(503, 'SERVER_SAVES_UNAVAILABLE');
  if (!ID.test(id)) throw new SaveError(404, 'NOT_FOUND');
  const row = (await db.query('SELECT pack_id, manifest_digest, scenario_id, framework_id, parameters, expires_at FROM lm_saved_scenarios WHERE id_digest=$1 AND deleted_at IS NULL AND expires_at>now()', [sha(id)])).rows[0];
  if (!row) throw new SaveError(404, 'NOT_FOUND');
  const pack = await loadPack(row.pack_id, row.manifest_digest).catch(() => null);
  const status = pack?.catalog.releases.find(r => r.manifestDigest === row.manifest_digest)?.status ?? 'unavailable';
  const scenario = pack?.release.scenarios.find(s => s.id === row.scenario_id);
  const query = scenario ? encodeShare(scenario, { packId: row.pack_id, release: row.manifest_digest, scenarioId: row.scenario_id, framework: row.framework_id, step: null, params: row.parameters }) : null;
  return { packId: row.pack_id, manifestDigest: row.manifest_digest, scenarioId: row.scenario_id, frameworkId: row.framework_id, parameters: row.parameters, expiresAt: new Date(row.expires_at).toISOString(),
    releaseStatus: status, href: query ? '/packs/' + row.pack_id + '/scenarios/' + row.scenario_id + '?' + query : null };
}
export async function deleteSaved(id: string, token: string | null) {
  const db = database();
  if (!db) throw new SaveError(503, 'SERVER_SAVES_UNAVAILABLE');
  if (!ID.test(id) || !token || !ID.test(token)) throw new SaveError(404, 'NOT_FOUND');
  const n = (await db.query('UPDATE lm_saved_scenarios SET deleted_at=now() WHERE id_digest=$1 AND delete_digest=$2 AND deleted_at IS NULL', [sha(id), sha(token)])).rowCount;
  if (!n) throw new SaveError(404, 'NOT_FOUND');
  return { deleted: true };
}
export async function purgeSaved(): Promise<number> {
  const db = database();
  if (!db) return 0;
  return (await db.query("DELETE FROM lm_saved_scenarios WHERE expires_at < now() - interval '30 days' OR deleted_at < now() - interval '1 day'")).rowCount ?? 0;
}
