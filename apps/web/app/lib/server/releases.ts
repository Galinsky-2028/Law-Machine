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
  let dir = resolve(process.cwd());
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
