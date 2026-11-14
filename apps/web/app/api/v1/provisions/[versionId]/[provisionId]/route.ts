import { readCatalog, readRelease } from '../../../../../lib/server/releases.ts';

/** Exact public provision text and citation metadata from current published releases only. */
export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string; provisionId: string }> }) {
  const { versionId, provisionId } = await params;
  for (const pack of readCatalog().packs) {
    const data = readRelease(pack.packId);
    const doc = data?.release.documents.find(d => d.versionId === versionId);
    const p = doc?.provisions.find(x => x.id === provisionId);
    if (data && doc && p) return Response.json({ packId: pack.packId, releaseId: data.entry.releaseId, manifestDigest: data.entry.manifestDigest, versionId, sourceDigest: doc.sourceDigest,
      documentTitle: doc.title, kind: doc.kind, provision: { id: p.id, citation: p.citation, path: p.path, parentId: p.parentId, text: p.text, span: p.span } }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  }
  return Response.json({ error: 'PROVISION_NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
