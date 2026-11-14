import type { AuthorAction, AuthorContext, AuthorRole } from '../../../../../lib/author-auth.ts';
import { createInvitation, listMembers, requireAuthor, revokeMembership } from '../../../../../lib/server/auth.ts';
import {
  AuthoringError, createPack, decideCandidate, enqueue, getJob, getPack, importSource, listCandidates, listPacks, publish, requestValidation,
  restorePointer, savePack, sourceDocument, stagedBundle, withdraw, MAX_SOURCE_BYTES
} from '../../../../../lib/server/authoring.ts';
import { diagnostics } from '../../../../../lib/server/diagnostics.ts';
import { logEvent, requestId } from '../../../../../lib/server/telemetry.ts';

/**
 * LM-050 authoring API. Every route names its required action; authorization
 * (session, CSRF on mutations, current membership, role, publish reauthentication)
 * runs before any handler. Responses are private and never cached.
 */
type Handler = (ctx: AuthorContext, request: Request, params: string[]) => Promise<unknown>;
type Route = { method: 'GET' | 'POST' | 'PUT'; pattern: RegExp; action: AuthorAction; admin?: boolean; handler: Handler };
const json = async (request: Request, max = 2_000_000): Promise<Record<string, unknown>> => {
  const text = await request.text();
  if (text.length > max) throw new AuthoringError(413, 'REQUEST_TOO_LARGE');
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); return v; } catch { throw new AuthoringError(400, 'REQUEST_INVALID'); }
};
const ROLES: AuthorRole[] = ['contributor', 'editor', 'publisher'];
const routes: Route[] = [
  { method: 'GET', pattern: /^packs$/, action: 'view', handler: ctx => listPacks(ctx) },
  { method: 'POST', pattern: /^packs$/, action: 'edit', handler: async (ctx, r) => createPack(ctx, await json(r, 2000)) },
  { method: 'GET', pattern: /^packs\/([0-9a-f-]{36})$/, action: 'view', handler: (ctx, _r, [doc]) => getPack(ctx, doc!) },
  { method: 'PUT', pattern: /^packs\/([0-9a-f-]{36})$/, action: 'edit', handler: async (ctx, r, [doc]) => { const b = await json(r); return savePack(ctx, doc!, b.expectedRevision, b.payload); } },
  { method: 'POST', pattern: /^packs\/([0-9a-f-]{36})\/validate$/, action: 'edit', handler: (ctx, _r, [doc]) => requestValidation(ctx, doc!) },
  { method: 'GET', pattern: /^packs\/([0-9a-f-]{36})\/preview\/([a-f0-9]{64})$/, action: 'view', handler: (ctx, _r, [doc, digest]) => stagedBundle(ctx, doc!, digest!) },
  { method: 'POST', pattern: /^packs\/([0-9a-f-]{36})\/publish$/, action: 'publish', handler: async (ctx, r, [doc]) => publish(ctx, doc!, String((await json(r, 2000)).releaseId ?? '')) },
  { method: 'POST', pattern: /^packs\/([0-9a-f-]{36})\/withdraw$/, action: 'publish', handler: async (ctx, r, [doc]) => { const b = await json(r, 4000); return withdraw(ctx, doc!, String(b.releaseId ?? ''), String(b.note ?? '')); } },
  { method: 'POST', pattern: /^packs\/([0-9a-f-]{36})\/pointer$/, action: 'publish', handler: async (ctx, r, [doc]) => restorePointer(ctx, doc!, String((await json(r, 2000)).releaseId ?? '')) },
  { method: 'POST', pattern: /^packs\/([0-9a-f-]{36})\/ai$/, action: 'edit', handler: async (ctx, r, [doc]) => { const s = String((await json(r, 2000)).sourceId ?? ''); return { jobId: await enqueue(ctx, doc!, 'ai-extract', 'ai:' + s + ':' + new Date().toISOString().slice(0, 13), { sourceId: s }) }; } },
  { method: 'GET', pattern: /^packs\/([0-9a-f-]{36})\/candidates$/, action: 'view', handler: (ctx, _r, [doc]) => listCandidates(ctx, doc!) },
  { method: 'POST', pattern: /^packs\/([0-9a-f-]{36})\/candidates\/([0-9a-f-]{36})$/, action: 'edit', handler: async (ctx, r, [doc, id]) => decideCandidate(ctx, doc!, id!, String((await json(r, 2000)).disposition) as 'accepted') },
  { method: 'POST', pattern: /^imports$/, action: 'edit', handler: async (ctx, r) => {
    if (Number(r.headers.get('content-length') ?? '0') > MAX_SOURCE_BYTES + 100000) throw new AuthoringError(413, 'SOURCE_SIZE_INVALID');
    const form = await r.formData().catch(() => { throw new AuthoringError(400, 'MULTIPART_REQUIRED'); });
    const file = form.get('file');
    if (!(file instanceof File)) throw new AuthoringError(400, 'FILE_REQUIRED');
    const format = file.name.endsWith('.md') ? 'markdown' : file.name.endsWith('.txt') ? 'text' : null;
    if (!format) throw new AuthoringError(415, 'ONLY_TEXT_OR_MARKDOWN');
    const officialUrl = form.get('officialUrl');
    return importSource(ctx, String(form.get('documentId') ?? ''), { name: file.name.slice(0, 120), format, bytes: new Uint8Array(await file.arrayBuffer()), officialUrl: typeof officialUrl === 'string' && officialUrl ? officialUrl : null });
  } },
  { method: 'GET', pattern: /^sources\/([0-9a-f-]{36})$/, action: 'view', handler: (ctx, _r, [id]) => sourceDocument(ctx, id!) },
  { method: 'POST', pattern: /^sources\/([0-9a-f-]{36})\/refresh$/, action: 'edit', handler: async (ctx, r, [id]) => ({ jobId: await enqueue(ctx, String((await json(r, 2000)).documentId ?? ''), 'source-refresh', 'refresh:' + id + ':' + new Date().toISOString().slice(0, 13), { sourceId: id }) }) },
  { method: 'GET', pattern: /^jobs\/([0-9a-f-]{36})$/, action: 'view', handler: (ctx, _r, [id]) => getJob(ctx, id!) },
  { method: 'GET', pattern: /^members$/, action: 'view', handler: ctx => listMembers(ctx.organizationId) },
  { method: 'POST', pattern: /^invitations$/, action: 'publish', admin: true, handler: async (ctx, r) => { const role = String((await json(r, 2000)).role) as AuthorRole; if (!ROLES.includes(role)) throw new AuthoringError(400, 'ROLE_INVALID'); return createInvitation(ctx.organizationId, role, ctx.subject); } },
  { method: 'POST', pattern: /^members\/([0-9a-f-]{36})\/revoke$/, action: 'publish', admin: true, handler: async (ctx, _r, [actor]) => { if (actor === ctx.subject) throw new AuthoringError(400, 'CANNOT_REVOKE_SELF'); return { revoked: await revokeMembership(ctx.organizationId, actor!) }; } },
  { method: 'GET', pattern: /^diagnostics$/, action: 'view', handler: ctx => diagnostics(ctx) }
];

async function dispatch(method: Route['method'], request: Request, context: { params: Promise<{ org: string; path: string[] }> }) {
  const { org, path } = await context.params;
  const id = requestId(request);
  const headers = { 'Cache-Control': 'no-store, private', 'X-Request-Id': id };
  const joined = (path ?? []).join('/');
  const route = routes.find(r => r.method === method && r.pattern.test(joined));
  if (!route) return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers });
  const ctx = await requireAuthor(request, org, route.action);
  if (ctx instanceof Response) return ctx;
  try {
    const params = route.pattern.exec(joined)!.slice(1);
    const body = await route.handler(ctx, request, params);
    return Response.json(body ?? { ok: true }, { headers });
  } catch (error) {
    if (error instanceof AuthoringError) return Response.json({ code: error.code }, { status: error.status, headers });
    logEvent('author.error', { requestId: id, route: route.pattern.source.slice(0, 60), code: String((error as Error)?.message ?? '').replace(/[^A-Z0-9_]/g, '').slice(0, 60) || 'INTERNAL' }, 'error');
    return Response.json({ code: 'INTERNAL_ERROR', requestId: id }, { status: 500, headers });
  }
}
export const GET = (r: Request, c: { params: Promise<{ org: string; path: string[] }> }) => dispatch('GET', r, c);
export const POST = (r: Request, c: { params: Promise<{ org: string; path: string[] }> }) => dispatch('POST', r, c);
export const PUT = (r: Request, c: { params: Promise<{ org: string; path: string[] }> }) => dispatch('PUT', r, c);
