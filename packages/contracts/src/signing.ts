import { canonicalJSON } from './integrity.ts';

/**
 * LM-057 publisher signatures. A signature binds a publisher key to a manifest
 * digest; it establishes provenance only, never legal correctness. Content
 * hashing (integrity.ts) and signature trust are checked separately.
 *
 * Key policy:
 *  - `active` keys sign new releases.
 *  - `retired` keys still verify signatures dated inside their validity window.
 *  - `revoked` keys verify nothing. Releases they signed must be deliberately
 *    re-signed by a trusted key after review; a replacement is never trusted
 *    silently because it claims an earlier signing date.
 */
export const SIGNATURE_FORMAT = 'law-machine-release-signature-v1' as const;
export const SIGNATURE_ALGORITHM = 'ECDSA-P256-SHA256' as const;
export type TrustedKey = {
  readonly keyId: string; readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly publicKeyJwk: JsonWebKey;
  readonly status: 'active' | 'retired' | 'revoked';
  readonly validFrom: string; readonly validUntil: string | null;
  readonly revokedAt: string | null; readonly note: string;
};
export type TrustStore = { readonly format: 'law-machine-trust-v1'; readonly keys: readonly TrustedKey[] };
export type ReleaseSignature = {
  readonly format: typeof SIGNATURE_FORMAT; readonly keyId: string;
  readonly manifestDigest: string; readonly signedAt: string; readonly signature: string;
};
export type SignatureCheck = { readonly valid: boolean; readonly reason: 'VALID' | 'UNSIGNED' | 'MALFORMED' | 'UNKNOWN_KEY' | 'KEY_REVOKED' | 'OUTSIDE_KEY_VALIDITY' | 'DIGEST_MISMATCH' | 'BAD_SIGNATURE'; readonly keyId: string | null };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const time = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/.test(v) && Number.isFinite(Date.parse(v));
const b64url = {
  encode(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  decode(text: string): Uint8Array { const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); }
};
const payload = (keyId: string, manifestDigest: string, signedAt: string) =>
  new TextEncoder().encode(canonicalJSON({ format: SIGNATURE_FORMAT, keyId, manifestDigest, signedAt }));
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export async function generateSigningKey(): Promise<{ privateKeyJwk: JsonWebKey; publicKeyJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const { d: _secret, ...publicKeyJwk } = privateKeyJwk;
  void _secret;
  return { privateKeyJwk, publicKeyJwk: { ...publicKeyJwk, key_ops: ['verify'] } };
}
export async function signManifest(privateKeyJwk: JsonWebKey, keyId: string, manifestDigest: string, signedAt: string): Promise<ReleaseSignature> {
  if (!ID.test(keyId) || !SHA.test(manifestDigest) || !time(signedAt) || !privateKeyJwk || privateKeyJwk.kty !== 'EC' || privateKeyJwk.crv !== 'P-256' || !privateKeyJwk.d) throw Error('SIGNING_INPUT_INVALID');
  const key = await crypto.subtle.importKey('jwk', { ...privateKeyJwk, key_ops: ['sign'] }, algorithm, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload(keyId, manifestDigest, signedAt)));
  return { format: SIGNATURE_FORMAT, keyId, manifestDigest, signedAt, signature: b64url.encode(signature) };
}
export function validateTrustStore(store: unknown): TrustStore {
  const s = store as TrustStore;
  if (!s || s.format !== 'law-machine-trust-v1' || !Array.isArray(s.keys) || s.keys.length > 64) throw Error('TRUST_STORE_INVALID');
  const ids = new Set<string>();
  for (const k of s.keys) {
    if (!k || !ID.test(k.keyId) || ids.has(k.keyId) || k.algorithm !== SIGNATURE_ALGORITHM || !k.publicKeyJwk || k.publicKeyJwk.kty !== 'EC' ||
        k.publicKeyJwk.crv !== 'P-256' || 'd' in k.publicKeyJwk || !['active', 'retired', 'revoked'].includes(k.status) || !time(k.validFrom) ||
        !(k.validUntil === null || time(k.validUntil)) || !(k.revokedAt === null || time(k.revokedAt)) || (k.status === 'revoked') !== (k.revokedAt !== null) ||
        typeof k.note !== 'string' || k.note.length > 500) throw Error('TRUST_STORE_INVALID');
    ids.add(k.keyId);
  }
  if (s.keys.filter(k => k.status === 'active').length > 2) throw Error('TRUST_STORE_TOO_MANY_ACTIVE_KEYS');
  return s;
}
/** Verify one signature against the trust store. `expectedDigest` comes from the verified manifest bytes. */
export async function verifyReleaseSignature(store: TrustStore, expectedDigest: string, signature: ReleaseSignature | null | undefined, _publishedAt?: string): Promise<SignatureCheck> {
  if (!signature) return { valid: false, reason: 'UNSIGNED', keyId: null };
  if (signature.format !== SIGNATURE_FORMAT || !ID.test(signature.keyId) || !SHA.test(signature.manifestDigest) || !time(signature.signedAt) ||
      typeof signature.signature !== 'string' || signature.signature.length > 200) return { valid: false, reason: 'MALFORMED', keyId: null };
  if (signature.manifestDigest !== expectedDigest) return { valid: false, reason: 'DIGEST_MISMATCH', keyId: signature.keyId };
  let trusted: TrustStore;
  try { trusted = validateTrustStore(store); } catch { return { valid: false, reason: 'UNKNOWN_KEY', keyId: signature.keyId }; }
  const key = trusted.keys.find(k => k.keyId === signature.keyId);
  if (!key) return { valid: false, reason: 'UNKNOWN_KEY', keyId: signature.keyId };
  if (key.status === 'revoked') return { valid: false, reason: 'KEY_REVOKED', keyId: key.keyId };
  const at = Date.parse(signature.signedAt);
  if (at < Date.parse(key.validFrom) || (key.validUntil !== null && at > Date.parse(key.validUntil))) return { valid: false, reason: 'OUTSIDE_KEY_VALIDITY', keyId: key.keyId };
  let ok = false;
  try {
    const publicKey = await crypto.subtle.importKey('jwk', { ...key.publicKeyJwk, key_ops: ['verify'] }, algorithm, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64url.decode(signature.signature), payload(signature.keyId, signature.manifestDigest, signature.signedAt));
  } catch { ok = false; }
  return ok ? { valid: true, reason: 'VALID', keyId: key.keyId } : { valid: false, reason: 'BAD_SIGNATURE', keyId: key.keyId };
}
