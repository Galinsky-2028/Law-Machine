import { fullCatalog } from '../../../lib/server/releases.ts';

/** Public catalog of released packs. Short bounded caching; release files themselves are immutable. */
export async function GET() {
  const { bases: _bases, ...catalog } = await fullCatalog();
  void _bases;
  return Response.json(catalog, { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } });
}
