import { authEnabled, ceremonyResponse, finishRegistration, sameOriginMutation } from '../../../../../lib/server/auth.ts';
import { rateLimit } from '../../../../../lib/server/rate-limit.ts';
export async function POST(request: Request) {
  if (!authEnabled()) return Response.json({ code: 'AUTHORING_DISABLED' }, { status: 503 });
  if (!sameOriginMutation(request)) return Response.json({ code: 'CSRF_INVALID' }, { status: 403 });
  if (!rateLimit(request, 'passkey', 20)) return Response.json({ code: 'RATE_LIMITED' }, { status: 429 });
  const text = await request.text();
  if (text.length > 20000) return Response.json({ code: 'REQUEST_TOO_LARGE' }, { status: 413 });
  let body: unknown; try { body = JSON.parse(text); } catch { return Response.json({ code: 'REQUEST_INVALID' }, { status: 400 }); }
  return ceremonyResponse(await finishRegistration(request, body));
}
