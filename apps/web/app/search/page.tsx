import type { Metadata } from 'next';
import { Suspense } from 'react';
import { readCatalog, readRelease } from '../lib/server/releases.ts';
import { buildSearchDocs } from '../../../../packages/presentation/src/index.ts';
import { SiteFooter, SiteHeader } from '../components/SiteHeader.tsx';
import { SearchBox } from '../components/SearchBox.tsx';

export const metadata: Metadata = { title: 'Search | Law Machine' };
/** Only current published releases are indexed. */
export default function SearchPage() {
  const docs = readCatalog().packs.flatMap(p => buildSearchDocs(readRelease(p.packId)!.release, '/packs/' + p.packId));
  const packs = readCatalog().packs.map(p => ({ id: p.packId, title: p.title }));
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/search', label: 'Search' }]} />
    <main id="main" className="search">
      <h1>Search</h1>
      <p className="intro">Search rules, sources, scenarios and terms in plain words — no section numbers needed.</p>
      <Suspense fallback={null}><SearchBox docs={docs} packs={packs} /></Suspense>
    </main>
    <SiteFooter />
  </>;
}
