import { accountOverview, authEnabled, currentActor } from '../../../lib/server/auth.ts';
import { aiStatus } from '../../../lib/server/ai.ts';
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store, private' };
  if (!authEnabled()) return Response.json({ code: 'AUTHORING_DISABLED' }, { status: 503, headers });
  const actor = await currentActor(request);
  if (!actor) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401, headers });
  const overview = await accountOverview(actor.actorId);
  return Response.json({ ...overview, csrf: actor.csrf, reauthenticatedAt: new Date(actor.lastReauthenticatedAt).toISOString(), ai: aiStatus() }, { headers });
}
