import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readCatalog, readRelease } from '../../../lib/server/releases.ts';
import { SiteFooter, SiteHeader } from '../../../components/SiteHeader.tsx';

type Props = { params: Promise<{ packId: string }> };
export const dynamicParams = false;
export function generateStaticParams() { return readCatalog().packs.map(p => ({ packId: p.packId })); }
export const metadata: Metadata = { title: 'Glossary | Law Machine' };

export default async function Glossary({ params }: Props) {
  const { packId } = await params;
  const data = readRelease(packId);
  if (!data) notFound();
  const { release } = data;
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/packs/' + packId, label: release.title }, { href: '/packs/' + packId + '/glossary', label: 'Glossary' }]} />
    <main id="main" className="glossary">
      <h1>Glossary</h1>
      <p className="intro">Plain meanings first. Open a term for detail and the exact source.</p>
      <dl>{[...release.glossary].sort((a, b) => a.term.localeCompare(b.term)).map(g => <div key={g.id} id={g.id} className="glossary__entry">
        <dt>{g.term}</dt>
        <dd><p>{g.plain}</p><details><summary>More detail</summary><p>{g.detail}</p>
          {g.sourceRefs.map((r, i) => { const d = release.documents.find(x => x.versionId === r.versionId); const p = d?.provisions.find(x => x.id === r.provisionId); return p && d ? <blockquote key={i}><p>“{r.quote}”</p><footer><a href={'/packs/' + packId + '/sources/' + d.sourceId + '#' + p.id}>{p.citation}</a>, {d.title}</footer></blockquote> : null; })}
          {g.related.length > 0 && <p>Related: {g.related.map(id => <a key={id} href={'#' + id}>{release.glossary.find(x => x.id === id)?.term ?? id}</a>).reduce<React.ReactNode[]>((acc, el, i) => i ? [...acc, ', ', el] : [el], [])}</p>}
        </details></dd>
      </div>)}</dl>
    </main>
    <SiteFooter />
  </>;
}
