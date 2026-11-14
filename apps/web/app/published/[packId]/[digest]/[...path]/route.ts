import { publishedAsset } from '../../../../lib/server/published.ts';

/** Immutable public files for database-published releases; same layout as /releases. */
export async function GET(_request: Request, { params }: { params: Promise<{ packId: string; digest: string; path: string[] }> }) {
  const { packId, digest, path } = await params;
  const name = (path ?? []).join('/');
  const bytes = await publishedAsset(packId, digest, name);
  if (!bytes) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const type = name.endsWith('.json') ? 'application/json' : name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  return new Response(Buffer.from(bytes), { headers: { 'Content-Type': type, 'Cache-Control': name === 'signature.json' ? 'public, max-age=300' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });
}
