import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { authorizeAuthorAction, type AuthorAction, type AuthorContext, type AuthorRole } from '../author-auth.ts';
import { createSessionCookiePair, StoredCookieAuthorIdentityAdapter } from '../author-cookie-session.ts';
import { createAuthorLogoutHandler } from '../author-logout.ts';
import { PostgresAuthorSessionStore } from '../author-postgres-session-store.ts';
import { logEvent } from './telemetry.ts';

/**
 * LM-043 author identity: WebAuthn passkeys verified with the maintained
 * @simplewebauthn/server library, mapped through lm_author_identities to an
 * internal actor and issued as hashed opaque cookie sessions. Only the
 * dedicated lm_auth database role can read identity, credential or session rows.
 */
export const SESSION_SECONDS = 8 * 3600;
const CEREMONY_COOKIE = '__Host-lm_ceremony';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export type AuthConfig = { readonly origin: string; readonly rpID: string; readonly rpName: string };
export function authConfig(): AuthConfig {
  const origin = process.env.LM_ORIGIN ?? 'http://localhost:3000';
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' && url.hostname !== 'localhost')) throw Error('LM_ORIGIN_INVALID');
  return { origin, rpID: url.hostname, rpName: 'Law Machine' };
}
let pool: pg.Pool | null | undefined;
export function authPool(): pg.Pool | null {
  if (pool !== undefined) return pool;
  const url = process.env.AUTH_DATABASE_URL;
  pool = url ? new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 10000, application_name: 'law-machine-auth' }) : null;
  pool?.on('error', () => undefined);
  return pool;
}
export function authEnabled(): boolean { return !!authPool() && !!process.env.DATABASE_URL; }

function sessionStore(): PostgresAuthorSessionStore | null {
  const p = authPool();
  if (!p) return null;
  return new PostgresAuthorSessionStore({
    queryAuth: (sql, params) => p.query(sql, params as unknown[]),
    async queryInOrganization(organizationId, sql, params) {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
        const result = await client.query(sql, params as unknown[]);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    }
  });
}
export function identityAdapter(): StoredCookieAuthorIdentityAdapter | null {
  const store = sessionStore();
  return store ? new StoredCookieAuthorIdentityAdapter(store) : null;
}

/** Authorize an author request; returns a context or a fail-closed JSON response. */
export async function requireAuthor(request: Request, organizationId: string, action: AuthorAction): Promise<AuthorContext | Response> {
  const adapter = identityAdapter();
  const headers = { 'Cache-Control': 'no-store, private' };
  if (!adapter) return Response.json({ code: 'AUTHORING_DISABLED' }, { status: 503, headers });
  const outcome = await authorizeAuthorAction({ request, organizationId, action, adapter });
  if (outcome.authorized) return outcome.context;
  const status = outcome.code === 'AUTH_REQUIRED' || outcome.code === 'SESSION_EXPIRED' || outcome.code === 'SESSION_INVALID' ? 401 : 403;
  logEvent('author.denied', { code: outcome.code, route: new URL(request.url).pathname.split('/').slice(0, 5).join('/') }, 'warn');
  return Response.json({ code: outcome.code }, { status, headers });
}
/** Session-only check (no organization), used for the author's own account views. */
export async function currentActor(request: Request): Promise<{ actorId: string; sessionId: string; csrf: string; lastReauthenticatedAt: number } | null> {
  const adapter = identityAdapter();
  const session = adapter ? await adapter.verifySession(request).catch(() => null) : null;
  return session ? { actorId: session.subject, sessionId: session.sessionId, csrf: session.csrfToken, lastReauthenticatedAt: session.lastReauthenticatedAt } : null;
}
export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === authConfig().origin && new URL(request.url).origin === origin;
}
function ceremonyCookie(request: Request): string | null {
  const raw = request.headers.get('cookie') ?? '';
  const match = raw.split(';').map(s => s.trim()).filter(s => s.startsWith(CEREMONY_COOKIE + '='));
  if (match.length !== 1) return null;
  const value = match[0]!.slice(CEREMONY_COOKIE.length + 1);
  return TOKEN.test(value) ? value : null;
}
const newCeremony = () => { const token = randomBytes(32).toString('base64url'); return { token, digest: sha(token), cookie: CEREMONY_COOKIE + '=' + token + '; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=600' }; };
const clearCeremony = CEREMONY_COOKIE + '=; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=0';

async function withAuth<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const p = authPool();
  if (!p) throw Error('AUTHORING_DISABLED');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
async function issueSession(client: pg.PoolClient, actorId: string): Promise<string[]> {
  const pair = createSessionCookiePair(SESSION_SECONDS);
  await client.query(`INSERT INTO lm_author_sessions(id,token_digest,csrf_digest,provider,subject,actor_id,issued_at,expires_at,last_reauthenticated_at)
    VALUES ($1,$2,$3,'webauthn',$4,$5,now(),now()+make_interval(secs=>$6),now())`, [randomUUID(), pair.tokenDigest, pair.csrfDigest, actorId, actorId, SESSION_SECONDS]);
  return [pair.sessionSetCookie, pair.csrfSetCookie];
}
async function consumeChallenge(client: pg.PoolClient, request: Request, purpose: 'register' | 'authenticate') {
  const token = ceremonyCookie(request);
  if (!token) return null;
  const rows = (await client.query(`DELETE FROM lm_webauthn_challenges WHERE browser_digest=$1 AND purpose=$2 AND expires_at>now()
    RETURNING challenge, actor_id, invitation_digest, display_name`, [sha(token), purpose])).rows;
  // Any other challenge for this browser is also consumed: a ceremony is single-use.
  await client.query('DELETE FROM lm_webauthn_challenges WHERE browser_digest=$1 OR expires_at<=now()', [sha(token)]);
  return rows.length === 1 ? rows[0] as { challenge: string; actor_id: string | null; invitation_digest: string | null; display_name: string | null } : null;
}

export type CeremonyResult = { readonly status: number; readonly body: unknown; readonly cookies: readonly string[] };
const fail = (status: number, code: string, cookies: string[] = [clearCeremony]): CeremonyResult => ({ status, body: { code }, cookies });

/** Enrollment starts from a one-time invitation code, or from a signed-in author adding a passkey. */
export async function startRegistration(request: Request, input: { invitationCode?: unknown; displayName?: unknown }): Promise<CeremonyResult> {
  const cfg = authConfig();
  const signedIn = await currentActor(request);
  const name = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 80) : '';
  let invitationDigest: string | null = null;
  if (!signedIn) {
    if (typeof input.invitationCode !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.invitationCode)) return fail(400, 'INVITATION_REQUIRED');
    if (!name) return fail(400, 'DISPLAY_NAME_REQUIRED');
    invitationDigest = sha(input.invitationCode);
  }
  return withAuth(async client => {
    let excludeCredentials: { id: string }[] = [];
    if (invitationDigest) {
      const ok = (await client.query('SELECT 1 FROM lm_invitations WHERE code_digest=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()', [invitationDigest])).rowCount;
      if (!ok) return fail(403, 'INVITATION_INVALID');
    } else excludeCredentials = (await client.query('SELECT credential_id FROM lm_webauthn_credentials WHERE actor_id=$1 AND revoked_at IS NULL', [signedIn!.actorId])).rows.map(r => ({ id: String(r.credential_id) }));
    const actorId = signedIn?.actorId ?? randomUUID();
    const options = await generateRegistrationOptions({
      rpName: cfg.rpName, rpID: cfg.rpID, userName: name || 'Law Machine author', userDisplayName: name || 'Law Machine author',
      userID: new TextEncoder().encode(actorId), attestationType: 'none', excludeCredentials,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 120000
    });
    const ceremony = newCeremony();
    await client.query(`INSERT INTO lm_webauthn_challenges(id,challenge,purpose,browser_digest,actor_id,invitation_digest,display_name,expires_at)
      VALUES ($1,$2,'register',$3,$4,$5,$6,now()+interval '5 minutes')`, [randomUUID(), options.challenge, ceremony.digest, actorId, invitationDigest, name || null]);
    return { status: 200, body: options, cookies: [ceremony.cookie] };
  });
}

export async function finishRegistration(request: Request, response: unknown): Promise<CeremonyResult> {
  const cfg = authConfig();
  const signedIn = await currentActor(request);
  return withAuth(async client => {
    const challenge = await consumeChallenge(client, request, 'register');
    if (!challenge || !challenge.actor_id || !UUID.test(challenge.actor_id)) return fail(400, 'CHALLENGE_INVALID');
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, expectedChallenge: challenge.challenge,
        expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true });
    } catch { return fail(400, 'REGISTRATION_INVALID'); }
    if (!verification.verified) return fail(400, 'REGISTRATION_INVALID');
    const credential = verification.registrationInfo.credential;
    const actorId = challenge.actor_id;
    if (challenge.invitation_digest) {
      const invitation = (await client.query(`UPDATE lm_invitations SET used_at=now(), used_by=$2
        WHERE code_digest=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING org_id, role`, [challenge.invitation_digest, actorId])).rows[0];
      if (!invitation) return fail(403, 'INVITATION_INVALID');
      await client.query('INSERT INTO lm_actors(id, display_name) VALUES ($1,$2)', [actorId, challenge.display_name ?? 'Author']);
      await client.query("INSERT INTO lm_author_identities(provider, subject, actor_id) VALUES ('webauthn', $1, $2)", [actorId, actorId]);
      await client.query('INSERT INTO lm_memberships(org_id, actor_id, role) VALUES ($1,$2,$3)', [invitation.org_id, actorId, invitation.role]);
    } else if (!signedIn || signedIn.actorId !== actorId) return fail(401, 'AUTH_REQUIRED');
    try {
      await client.query('INSERT INTO lm_webauthn_credentials(credential_id, actor_id, public_key, sign_count, transports) VALUES ($1,$2,$3,$4,$5)',
        [credential.id, actorId, Buffer.from(credential.publicKey), credential.counter, (credential.transports ?? []).slice(0, 8)]);
    } catch { return fail(409, 'CREDENTIAL_ALREADY_REGISTERED'); }
    const cookies = signedIn ? [] : await issueSession(client, actorId);
    logEvent('author.passkey.registered', { kind: signedIn ? 'additional' : 'enrollment' });
    return { status: 200, body: { ok: true }, cookies: [clearCeremony, ...cookies] };
  });
}

export async function startLogin(): Promise<CeremonyResult> {
  const cfg = authConfig();
  return withAuth(async client => {
    const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required', timeout: 120000 });
    const ceremony = newCeremony();
    await client.query(`INSERT INTO lm_webauthn_challenges(id,challenge,purpose,browser_digest,expires_at) VALUES ($1,$2,'authenticate',$3,now()+interval '5 minutes')`,
      [randomUUID(), options.challenge, ceremony.digest]);
    return { status: 200, body: options, cookies: [ceremony.cookie] };
  });
}

/** Successful login (or reauthentication) issues a fresh session and revokes the caller's previous one. */
export async function finishLogin(request: Request, response: unknown): Promise<CeremonyResult> {
  const cfg = authConfig();
  const previous = await currentActor(request);
  return withAuth(async client => {
    const challenge = await consumeChallenge(client, request, 'authenticate');
    const body = response as AuthenticationResponseJSON;
    if (!challenge || !body || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{16,1366}$/.test(body.id)) return fail(400, 'CHALLENGE_INVALID');
    const row = (await client.query('SELECT credential_id, actor_id, public_key, sign_count, transports FROM lm_webauthn_credentials WHERE credential_id=$1 AND revoked_at IS NULL', [body.id])).rows[0];
    if (!row) return fail(401, 'CREDENTIAL_UNKNOWN');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({ response: body, expectedChallenge: challenge.challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID,
        credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.sign_count), transports: row.transports }, requireUserVerification: true });
    } catch { return fail(401, 'AUTHENTICATION_INVALID'); }
    if (!verification.verified) return fail(401, 'AUTHENTICATION_INVALID');
    const counter = verification.authenticationInfo.newCounter;
    // A counter that does not advance (when the authenticator uses one) indicates a cloned credential.
    if (Number(row.sign_count) > 0 && counter <= Number(row.sign_count)) { logEvent('author.passkey.counter_regression', {}, 'warn'); return fail(401, 'AUTHENTICATION_INVALID'); }
    await client.query('UPDATE lm_webauthn_credentials SET sign_count=$2, last_used_at=now() WHERE credential_id=$1', [row.credential_id, counter]);
    const active = (await client.query('SELECT 1 FROM lm_memberships WHERE actor_id=$1 AND revoked_at IS NULL', [row.actor_id])).rowCount;
    if (!active) return fail(403, 'MEMBERSHIP_REQUIRED');
    if (previous) await client.query('UPDATE lm_author_sessions SET revoked_at=now() WHERE id=$1 AND actor_id=$2 AND revoked_at IS NULL', [previous.sessionId, previous.actorId]);
    const cookies = await issueSession(client, row.actor_id);
    logEvent('author.login', { kind: previous ? 'reauthenticate' : 'login' });
    return { status: 200, body: { ok: true }, cookies: [clearCeremony, ...cookies] };
  });
}

export async function logout(request: Request): Promise<Response> {
  const store = sessionStore();
  if (!store) return Response.json({ code: 'AUTHORING_DISABLED' }, { status: 503 });
  return createAuthorLogoutHandler(store, authConfig().origin)(request);
}

export type Membership = { organizationId: string; slug: string; role: AuthorRole };
export async function accountOverview(actorId: string): Promise<{ actorId: string; displayName: string; memberships: Membership[]; passkeys: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[] }> {
  return withAuth(async client => {
    const actor = (await client.query('SELECT display_name FROM lm_actors WHERE id=$1', [actorId])).rows[0];
    const memberships = (await client.query(`SELECT m.org_id, o.slug, m.role FROM lm_memberships m JOIN lm_organizations o ON o.id=m.org_id
      WHERE m.actor_id=$1 AND m.revoked_at IS NULL ORDER BY o.slug`, [actorId])).rows.map(r => ({ organizationId: r.org_id, slug: r.slug, role: r.role }));
    const passkeys = (await client.query('SELECT credential_id, label, created_at, last_used_at FROM lm_webauthn_credentials WHERE actor_id=$1 AND revoked_at IS NULL ORDER BY created_at', [actorId])).rows
      .map(r => ({ id: String(r.credential_id).slice(0, 12), label: r.label, createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
    return { actorId, displayName: actor?.display_name ?? 'Author', memberships, passkeys };
  });
}
/** Revoking a membership also revokes that actor's sessions, so access ends immediately. */
export async function revokeMembership(organizationId: string, actorId: string): Promise<boolean> {
  return withAuth(async client => {
    await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
    const changed = (await client.query('UPDATE lm_memberships SET revoked_at=now() WHERE org_id=$1 AND actor_id=$2 AND revoked_at IS NULL', [organizationId, actorId])).rowCount;
    if (changed) await client.query('UPDATE lm_author_sessions SET revoked_at=now() WHERE actor_id=$1 AND revoked_at IS NULL', [actorId]);
    return !!changed;
  });
}
export async function createInvitation(organizationId: string, role: AuthorRole, createdBy: string): Promise<{ code: string; expiresAt: string }> {
  const code = randomBytes(24).toString('base64url');
  return withAuth(async client => {
    const row = (await client.query(`INSERT INTO lm_invitations(org_id,id,code_digest,role,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '7 days') RETURNING expires_at`,
      [organizationId, randomUUID(), sha(code), role, createdBy])).rows[0];
    return { code, expiresAt: new Date(row.expires_at).toISOString() };
  });
}
export async function listMembers(organizationId: string): Promise<{ actorId: string; displayName: string; role: AuthorRole; revokedAt: string | null }[]> {
  return withAuth(async client => (await client.query(`SELECT m.actor_id, a.display_name, m.role, m.revoked_at FROM lm_memberships m LEFT JOIN lm_actors a ON a.id=m.actor_id
    WHERE m.org_id=$1 ORDER BY m.revoked_at NULLS FIRST, a.display_name`, [organizationId])).rows
    .map(r => ({ actorId: r.actor_id, displayName: r.display_name ?? 'Author', role: r.role, revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null })));
}
export function ceremonyResponse(result: CeremonyResult): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store, private', 'Content-Type': 'application/json' });
  for (const c of result.cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}
