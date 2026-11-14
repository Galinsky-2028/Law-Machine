import type { CatalogPack, CatalogRelease, PackRelease } from '../../../../../packages/contracts/src/pack.ts';
import { database } from './db.ts';

/**
 * Public read path for releases published through authoring. Only rows the
 * lm_app public policies expose (published or withdrawn releases, published
 * assets) are reachable; staged previews never appear here.
 */
const SHA = /^[a-f0-9]{64}$/;
const PACK = /^[a-z0-9][a-z0-9-]{0,79}$/;
export async function publishedCatalog(): Promise<CatalogPack[]> {
  const db = database();
  if (!db) return [];
  try {
    const pointers = (await db.query('SELECT pack_id, manifest_digest FROM lm_publication_pointers ORDER BY pack_id')).rows;
    const out: CatalogPack[] = [];
    for (const p of pointers) {
      const rows = (await db.query("SELECT manifest_digest, release_id, label, status, published_at, note, signature IS NOT NULL AS signed, catalog FROM lm_releases WHERE pack_id=$1 AND status IN ('published','withdrawn') ORDER BY published_at DESC", [p.pack_id])).rows;
      const current = rows.find(r => r.manifest_digest === p.manifest_digest && r.status === 'published');
      if (!current?.catalog) continue;
      const releases: CatalogRelease[] = rows.map(r => ({ releaseId: r.release_id, manifestDigest: r.manifest_digest, label: r.label, publishedAt: new Date(r.published_at).toISOString().slice(0, 10),
        status: r.status === 'withdrawn' ? 'withdrawn' : r.manifest_digest === p.manifest_digest ? 'current' : 'superseded', note: r.note, signed: r.signed }));
      out.push({ ...current.catalog, current: p.manifest_digest, releases } as CatalogPack);
    }
    return out;
  } catch { return []; }
}
export async function publishedAsset(packId: string, digest: string, path: string): Promise<Uint8Array | null> {
  const db = database();
  if (!db || !PACK.test(packId) || !SHA.test(digest) || !/^(manifest\.json|signature\.json|assets\/[a-f0-9]{64}\.[a-z0-9]{1,8})$/.test(path)) return null;
  try {
    const rel = (await db.query("SELECT signature FROM lm_releases WHERE pack_id=$1 AND manifest_digest=$2 AND status='published'", [packId, digest])).rows[0];
    if (!rel) return null;
    if (path === 'signature.json') return rel.signature ? new TextEncoder().encode(JSON.stringify(rel.signature)) : null;
    const row = (await db.query('SELECT bytes FROM lm_release_assets WHERE manifest_digest=$1 AND path=$2', [digest, path])).rows[0];
    return row ? new Uint8Array(row.bytes) : null;
  } catch { return null; }
}
export async function publishedRelease(packId: string, digest?: string | null): Promise<{ release: PackRelease; manifestDigest: string; catalog: CatalogPack } | null> {
  const catalog = (await publishedCatalog()).find(p => p.packId === packId);
  if (!catalog) return null;
  const want = digest && SHA.test(digest) ? digest : catalog.current!;
  const manifest = await publishedAsset(packId, want, 'manifest.json');
  if (!manifest) return null;
  const bundlePath = JSON.parse(Buffer.from(manifest).toString('utf8')).bundlePath as string;
  const bundle = await publishedAsset(packId, want, bundlePath);
  return bundle ? { release: JSON.parse(Buffer.from(bundle).toString('utf8')) as PackRelease, manifestDigest: want, catalog } : null;
}
/** A pack whose every release was withdrawn shows that status instead of disappearing silently. */
export async function withdrawnNotice(packId: string): Promise<{ packId: string; title: string; note: string | null; withdrawnAt: string } | null> {
  const db = database();
  if (!db || !PACK.test(packId)) return null;
  try {
    const rows = (await db.query("SELECT status, catalog, note, withdrawn_at FROM lm_releases WHERE pack_id=$1 AND status IN ('published','withdrawn') ORDER BY coalesce(withdrawn_at, published_at) DESC", [packId])).rows;
    if (!rows.length || rows.some(r => r.status === 'published')) return null;
    const r = rows[0]!;
    return { packId, title: String(r.catalog?.title ?? packId), note: r.note ?? null, withdrawnAt: new Date(r.withdrawn_at).toISOString().slice(0, 10) };
  } catch { return null; }
}
export async function withdrawnPacks(): Promise<{ packId: string; title: string; reason: string }[]> {
  const db = database();
  if (!db) return [];
  try {
    const ids = (await db.query("SELECT DISTINCT pack_id FROM lm_releases WHERE status='withdrawn' AND pack_id IS NOT NULL")).rows.map(r => String(r.pack_id));
    const out = [];
    for (const id of ids) { const n = await withdrawnNotice(id); if (n) out.push({ packId: id, title: n.title, reason: 'Withdrawn by the publisher on ' + n.withdrawnAt + (n.note ? ': ' + n.note : '.') }); }
    return out;
  } catch { return []; }
}
