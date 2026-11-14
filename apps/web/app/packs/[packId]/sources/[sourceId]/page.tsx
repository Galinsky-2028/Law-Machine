import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadPack, readCatalog, readRelease } from '../../../../lib/server/releases.ts';
import { SiteFooter, SiteHeader } from '../../../../components/SiteHeader.tsx';

type Props = { params: Promise<{ packId: string; sourceId: string }> };
export const dynamicParams = true;
export const revalidate = 60;
export function generateStaticParams() {
  return readCatalog().packs.flatMap(p => readRelease(p.packId)!.release.documents.map(d => ({ packId: p.packId, sourceId: d.sourceId })));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { packId, sourceId } = await params;
  return { title: ((await loadPack(packId))?.release.documents.find(d => d.sourceId === sourceId)?.title ?? 'Source') + ' | Law Machine' };
}
const MODE: Record<string, string> = { modeled: 'Modeled as an executable rule', 'explanatory-only': 'Explanation only', ambiguous: 'Ambiguous — not modeled as certain', unsupported: 'Not supported', unmapped: 'Not reviewed' };

/** Source explorer: the exact pinned text, its structure, coverage and the rules that cite each provision. */
export default async function SourcePage({ params }: Props) {
  const { packId, sourceId } = await params;
  const data = await loadPack(packId);
  const doc = data?.release.documents.find(d => d.sourceId === sourceId);
  if (!data || !doc) notFound();
  const { release } = data;
  const entry = { manifestDigest: data.manifestDigest };
  const framework = release.frameworks.find(f => f.versionId === doc.versionId);
  const coverage = framework ? release.coverage.find(c => c.frameworkId === framework.id) : null;
  const depth = (id: string | null, n = 0): number => { const p = id ? doc.provisions.find(x => x.id === id) : null; return p && n < 10 ? depth(p.parentId, n + 1) : n; };
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/packs/' + packId, label: release.title }, { href: '/packs/' + packId + '/sources/' + sourceId, label: 'Source' }]} />
    <main id="main" className="source">
      <p className="eyebrow">{doc.kind === 'fictional' ? 'FICTIONAL TEXT' : doc.kind === 'bill' ? 'PROPOSED LEGISLATION' : 'BASELINE SOURCE'}</p>
      <h1>{doc.title}</h1>
      <dl className="source-meta">
        <div><dt>Version</dt><dd><code>{doc.versionId}</code></dd></div>
        <div><dt>Status</dt><dd>{framework ? framework.status + (framework.role === 'baseline' ? ', as of ' + framework.asOf : '') : 'reference'}</dd></div>
        <div><dt>Origin</dt><dd>{doc.origin}{doc.officialUrl ? <> · <a href={doc.officialUrl}>official source</a></> : null}</dd></div>
        <div><dt>Original bytes</dt><dd><a href={data.base + '/' + packId + '/' + entry.manifestDigest + '/' + doc.assetPath} download>Download</a> · SHA-256 <code title={doc.sourceDigest}>{doc.sourceDigest.slice(0, 16)}…</code></dd></div>
        <div><dt>Rights</dt><dd>{doc.rights}</dd></div>
      </dl>
      {coverage && <p className="coverage-statement">{coverage.statement}</p>}
      <ol className="provisions">{doc.provisions.map(p => {
        const cov = coverage?.entries.find(e => e.provisionId === p.id);
        const rules = framework?.rules.filter(r => cov?.ruleIds.includes(r.id)) ?? [];
        return <li key={p.id} id={p.id} className={'provision depth-' + Math.min(depth(p.parentId), 3) + ' cov-' + (cov?.mode ?? 'unmapped')}>
          <p className="provision__cite"><a href={'#' + p.id}>{p.citation}</a> <span className={'cov-badge cov-badge--' + (cov?.mode ?? 'unmapped')}>{MODE[cov?.mode ?? 'unmapped']}</span></p>
          <p className="provision-text">{p.text}</p>
          {cov?.reason && <p className="muted small">Why: {cov.reason}</p>}
          {rules.length > 0 && <details><summary>{rules.length} rule{rules.length > 1 ? 's' : ''} cite this</summary><ul>{rules.map(r => <li key={r.id}>{r.effect.summary}</li>)}</ul></details>}
        </li>;
      })}</ol>
      <p className="muted small">Text is shown exactly as preserved in the release. Citations pin this version and digest; if the text changes in a later version, older links are marked stale rather than redirected.</p>
    </main>
    <SiteFooter />
  </>;
}
