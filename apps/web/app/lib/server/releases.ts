import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Catalog, PackRelease, TrustStore } from '../../../../../packages/contracts/src/index.ts';

/**
 * Server-only access to committed, content-addressed public releases.
 * Draft or private authoring data never passes through this module.
 */
export type ReleaseEntry = { manifestDigest: string; releaseId: string; label: string; publishedAt: string; status: 'current' | 'superseded' | 'withdrawn'; note: string | null; signature: unknown };
export type ReleaseIndex = { packId: string; current: string | null; releases: ReleaseEntry[] };

function repositoryRoot(): string {
  let dir = resolve(/*turbopackIgnore: true*/ process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw Error('Repository root not found');
}
const root = repositoryRoot();
const releases = join(root, 'content', 'releases');
const ID = /^[a-z0-9-]{1,80}$/;
const SHA = /^[a-f0-9]{64}$/;
const cache = new Map<string, PackRelease>();

export function readCatalog(): Catalog {
  const path = join(root, 'apps', 'web', 'public', 'releases', 'catalog.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Catalog;
}
export function readTrust(): TrustStore {
  return JSON.parse(readFileSync(join(root, 'content', 'trust', 'release-keys.json'), 'utf8')) as TrustStore;
}
export function readIndex(packId: string): ReleaseIndex | null {
  if (!ID.test(packId)) return null;
  try { return JSON.parse(readFileSync(join(releases, packId, 'index.json'), 'utf8')) as ReleaseIndex; } catch { return null; }
}
/** Reads a bundle only through its manifest and only for a digest listed in the index. */
export function readRelease(packId: string, digest?: string | null): { release: PackRelease; entry: ReleaseEntry; index: ReleaseIndex } | null {
  const index = readIndex(packId);
  if (!index) return null;
  const wanted = digest && SHA.test(digest) ? digest : index.current;
  const entry = index.releases.find(r => r.manifestDigest === wanted);
  if (!entry) return null;
  const key = packId + '/' + entry.manifestDigest;
  let release = cache.get(key);
  if (!release) {
    const dir = join(releases, packId, entry.manifestDigest);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { bundlePath: string };
    if (!/^assets\/[a-f0-9]{64}\.json$/.test(manifest.bundlePath)) return null;
    release = JSON.parse(readFileSync(join(dir, manifest.bundlePath), 'utf8')) as PackRelease;
    cache.set(key, release);
  }
  return { release, entry, index };
}
export function readAsset(packId: string, digest: string, assetPath: string): Uint8Array | null {
  if (!ID.test(packId) || !SHA.test(digest) || !/^assets\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(assetPath)) return null;
  const index = readIndex(packId);
  if (!index?.releases.some(r => r.manifestDigest === digest)) return null;
  try { return new Uint8Array(readFileSync(join(releases, packId, digest, assetPath))); } catch { return null; }
}
export function readManifestBytes(packId: string, digest: string): Uint8Array | null {
  if (!ID.test(packId) || !SHA.test(digest)) return null;
  const index = readIndex(packId);
  if (!index?.releases.some(r => r.manifestDigest === digest)) return null;
  try { return new Uint8Array(readFileSync(join(releases, packId, digest, 'manifest.json'))); } catch { return null; }
}
export function currentPackIds(): string[] {
  return readCatalog().packs.map(p => p.packId);
}

/** Static (committed) releases first, then releases published through authoring. */
export type LoadedPack = { release: PackRelease; manifestDigest: string; catalog: import('../../../../../packages/contracts/src/index.ts').CatalogPack; base: '/releases' | '/published' };
export async function loadPack(packId: string, digest?: string | null): Promise<LoadedPack | null> {
  const local = readRelease(packId, digest);
  const entry = readCatalog().packs.find(p => p.packId === packId);
  if (local && entry) return { release: local.release, manifestDigest: local.entry.manifestDigest, catalog: entry, base: '/releases' };
  const { publishedRelease } = await import('./published.ts');
  const db = await publishedRelease(packId, digest);
  return db ? { ...db, base: '/published' } : null;
}
export async function fullCatalog(): Promise<import('../../../../../packages/contracts/src/index.ts').Catalog & { readonly bases: Record<string, '/releases' | '/published'> }> {
  const local = readCatalog();
  const { publishedCatalog } = await import('./published.ts');
  const extra = (await publishedCatalog()).filter(p => !local.packs.some(l => l.packId === p.packId));
  const bases: Record<string, '/releases' | '/published'> = {};
  for (const p of local.packs) bases[p.packId] = '/releases';
  for (const p of extra) bases[p.packId] = '/published';
  const { withdrawnPacks } = await import('./published.ts');
  return { ...local, packs: [...local.packs, ...extra], unavailable: [...local.unavailable, ...(await withdrawnPacks())], bases };
}
