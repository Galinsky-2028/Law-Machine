import { parseRunExport, verifyRunExport } from '../../../../../../../packages/simulation/src/pack-analysis.ts';
import { loadPack } from '../../../../lib/server/releases.ts';
import { recordVerification } from '../../../../lib/server/verification.ts';
import { logEvent, requestId } from '../../../../lib/server/telemetry.ts';

/**
 * LM-051 bounded server replay. The server never trusts a client outcome: it
 * reruns the pinned release with the same inputs. Body size and run budgets are
 * bounded, and nothing in the request body is logged.
 */
export async function POST(request: Request) {
  const id = requestId(request);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 200000) return Response.json({ valid: false, reason: 'INVALID_EXPORT' }, { status: 413 });
  const text = (await request.text()).slice(0, 200001);
  let claim;
  try { claim = parseRunExport(text); } catch { return Response.json({ valid: false, reason: 'INVALID_EXPORT' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
  const pack = await loadPack(claim.packId, claim.manifestDigest).catch(() => null);
  const entry = pack?.catalog.releases.find(r => r.manifestDigest === claim.manifestDigest);
  if (!pack || !entry || pack.manifestDigest !== claim.manifestDigest) return Response.json({ valid: false, reason: 'RELEASE_UNKNOWN' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (entry.status === 'withdrawn') return Response.json({ valid: false, reason: 'RELEASE_WITHDRAWN' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
  const outcome = await verifyRunExport(pack.release, claim.manifestDigest, claim);
  const record = outcome.valid ? await recordVerification(claim) : null;
  logEvent('run.verify', { requestId: id, packId: claim.packId, releaseId: claim.releaseId, valid: outcome.valid, reason: outcome.reason });
  return Response.json({ valid: outcome.valid, reason: outcome.reason, ...(record ? { record } : {}) }, { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': id } });
}
