import { deleteSaved, resolveSaved, SaveError } from '../../../../lib/server/saved.ts';
const headers = { 'Cache-Control': 'no-store' };
const wrap = async (fn: () => Promise<unknown>) => {
  try { return Response.json(await fn(), { headers }); }
  catch (e) { return e instanceof SaveError ? Response.json({ code: e.code }, { status: e.status, headers }) : Response.json({ code: 'INTERNAL_ERROR' }, { status: 500, headers }); }
};
export async function GET(_r: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; return wrap(() => resolveSaved(id)); }
export async function DELETE(r: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; return wrap(() => deleteSaved(id, r.headers.get('x-delete-token'))); }
