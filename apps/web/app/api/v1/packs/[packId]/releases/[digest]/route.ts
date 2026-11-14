import { readIndex, readManifestBytes } from '../../../../../../lib/server/releases.ts';

/** Immutable public manifest for one pinned release. Withdrawn releases report their status instead. */
export async function GET(_request: Request, { params }: { params: Promise<{ packId: string; digest: string }> }) {
  const { packId, digest } = await params;
  const entry = readIndex(packId)?.releases.find(r => r.manifestDigest === digest);
  if (!entry) return Response.json({ error: 'RELEASE_NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (entry.status === 'withdrawn') return Response.json({ error: 'RELEASE_WITHDRAWN', note: entry.note }, { status: 410, headers: { 'Cache-Control': 'public, max-age=60' } });
  const bytes = readManifestBytes(packId, digest);
  if (!bytes) return Response.json({ error: 'RELEASE_NOT_FOUND' }, { status: 404 });
  return new Response(Buffer.from(bytes), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Release-Status': entry.status, 'X-Content-Type-Options': 'nosniff' } });
}
