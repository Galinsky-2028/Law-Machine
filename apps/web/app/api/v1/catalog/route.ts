import { readCatalog } from '../../../lib/server/releases.ts';

/** Public catalog of released packs. Short bounded caching; release files themselves are immutable. */
export function GET() {
  return Response.json(readCatalog(), { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } });
}
