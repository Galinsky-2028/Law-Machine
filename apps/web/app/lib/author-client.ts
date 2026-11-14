'use client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

/** Browser helpers for the author area: passkey ceremonies and CSRF-protected JSON calls. */
export class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export function csrfToken(): string {
  const match = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('__Host-lm_csrf='));
  return match ? match.slice('__Host-lm_csrf='.length) : '';
}
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-law-machine-csrf': csrfToken() };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'), headers, credentials: 'same-origin',
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : null) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { code?: string }).code ?? 'HTTP_' + response.status);
  return data as T;
}
async function ceremony(path: string, body: unknown = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (data as { code?: string }).code ?? 'HTTP_' + r.status);
  return data;
}
export async function enrollWithInvitation(invitationCode: string, displayName: string) {
  const options = await ceremony('/api/author/passkey/register/options', { invitationCode, displayName });
  const response = await startRegistration({ optionsJSON: options });
  return ceremony('/api/author/passkey/register/verify', response);
}
export async function addPasskey() {
  const options = await ceremony('/api/author/passkey/register/options', {});
  return ceremony('/api/author/passkey/register/verify', await startRegistration({ optionsJSON: options }));
}
/** Sign in, or confirm identity again before publishing (reauthentication rotates the session). */
export async function signIn() {
  const options = await ceremony('/api/author/passkey/login/options');
  return ceremony('/api/author/passkey/login/verify', await startAuthentication({ optionsJSON: options }));
}
export async function signOut() {
  await fetch('/api/author/logout', { method: 'POST', headers: { 'x-law-machine-csrf': csrfToken() }, credentials: 'same-origin' });
}
export const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Please sign in.', SESSION_EXPIRED: 'Your session expired. Please sign in again.', SESSION_INVALID: 'Please sign in again.',
  ORG_ACCESS_DENIED: 'Your role does not allow this.', MEMBERSHIP_REQUIRED: 'You are not a member of this organization.', REAUTH_REQUIRED: 'Confirm with your passkey to continue.',
  CSRF_INVALID: 'The request was blocked as a possible cross-site request. Reload and try again.', STALE_REVISION: 'Someone saved a newer revision. Reload to merge before saving.',
  INVITATION_INVALID: 'That invitation code is not valid, already used, or expired.', AUTHORING_DISABLED: 'Authoring is not enabled on this deployment.',
  VALIDATION_REQUIRED: 'Validate the current revision before publishing.', VALIDATION_STALE: 'This build is for an older revision. Validate again.',
  RELEASE_LABEL_REUSED: 'That release label was already published. Change releaseLabel in Overview.', PACK_ID_TAKEN: 'That pack ID is already used.',
  SOURCE_STORAGE_KEY_MISSING: 'Private source storage is not configured on this deployment.', ONLY_TEXT_OR_MARKDOWN: 'Upload a .md or .txt file.',
  SOURCE_SIZE_INVALID: 'Sources must be under 2 MB.', RATE_LIMITED: 'Too many attempts. Wait a minute.'
};
export const explain = (e: unknown) => e instanceof ApiError ? (MESSAGES[e.code] ?? 'Request failed (' + e.code + ').') : e instanceof Error && e.name === 'NotAllowedError' ? 'The passkey request was cancelled.' : 'Something went wrong.';
