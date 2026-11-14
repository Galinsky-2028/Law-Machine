import { rateLimit } from '../../../lib/server/rate-limit.ts';
import { SaveError, saveScenario } from '../../../lib/server/saved.ts';
import { readText } from '../../../lib/server/body.ts';
const headers = { 'Cache-Control': 'no-store' };
export async function POST(request: Request) {
  if (!rateLimit(request, 'save', 10)) return Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers });
  let text: string;
  try { text = await readText(request, 6000); } catch { return Response.json({ code: 'REQUEST_TOO_LARGE' }, { status: 413, headers }); }
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { return Response.json({ code: 'REQUEST_INVALID' }, { status: 400, headers }); }
  try { return Response.json(await saveScenario(body), { status: 201, headers }); }
  catch (e) { return e instanceof SaveError ? Response.json({ code: e.code }, { status: e.status, headers }) : Response.json({ code: 'INTERNAL_ERROR' }, { status: 500, headers }); }
}
