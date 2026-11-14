import { canonicalJSON } from '../../../../../packages/contracts/src/integrity.ts';
import type { RunExport } from '../../../../../packages/simulation/src/pack-analysis.ts';
import { database } from './db.ts';

/**
 * A server verification record states that this server recomputed the run.
 * It is signed with the verifier key when one is configured; otherwise the
 * response still reports the recomputation but carries no signed record.
 */
export async function recordVerification(claim: RunExport): Promise<{ verifiedAt: string; verifierKeyId: string; signature: string } | null> {
  const verifiedAt = new Date().toISOString();
  const raw = process.env.LM_VERIFIER_KEY, keyId = process.env.LM_VERIFIER_KEY_ID;
  let record: { verifiedAt: string; verifierKeyId: string; signature: string } | null = null;
  if (raw && keyId && /^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) {
    try {
      const jwk = JSON.parse(raw) as JsonWebKey;
      const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const payload = new TextEncoder().encode(canonicalJSON({ format: 'law-machine-verification-v1', runId: claim.runId, traceDigest: claim.traceDigest, manifestDigest: claim.manifestDigest, verifiedAt, keyId }));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload));
      record = { verifiedAt, verifierKeyId: keyId, signature: Buffer.from(sig).toString('base64url') };
    } catch { record = null; }
  }
  const db = database();
  if (db) {
    try {
      await db.query('INSERT INTO lm_run_verifications (run_id, trace_digest, manifest_digest, pack_id, verified_at, verifier_key_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id, trace_digest) DO NOTHING',
        [claim.runId, claim.traceDigest, claim.manifestDigest, claim.packId, verifiedAt, record?.verifierKeyId ?? null]);
    } catch { /* verification still returns; persistence is best effort and observable in diagnostics */ }
  }
  return record;
}
