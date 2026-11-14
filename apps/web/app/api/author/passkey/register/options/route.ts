import { authEnabled, ceremonyResponse, sameOriginMutation, startRegistration } from '../../../../../lib/server/auth.ts';
import { rateLimit } from '../../../../../lib/server/rate-limit.ts';
export async function POST(request: Request) {
  if (!authEnabled()) return Response.json({ code: 'AUTHORING_DISABLED' }, { status: 503 });
  if (!sameOriginMutation(request)) return Response.json({ code: 'CSRF_INVALID' }, { status: 403 });
  if (!rateLimit(request, 'passkey', 20)) return Response.json({ code: 'RATE_LIMITED' }, { status: 429 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  return ceremonyResponse(await startRegistration(request, body));
}
