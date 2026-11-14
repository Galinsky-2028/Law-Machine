import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readCatalog, readRelease } from '../../lib/server/releases.ts';
import { SiteFooter, SiteHeader } from '../../components/SiteHeader.tsx';

type Props = { params: Promise<{ packId: string }> };
export const dynamicParams = false;
export function generateStaticParams() { return readCatalog().packs.map(p => ({ packId: p.packId })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { packId } = await params;
  const data = readRelease(packId);
  return { title: (data?.release.title ?? 'Model') + ' | Law Machine', description: data?.release.summary ?? '' };
}
const date = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

export default async function PackLanding({ params }: Props) {
  const { packId } = await params;
  const data = readRelease(packId);
  const pack = readCatalog().packs.find(p => p.packId === packId);
  if (!data || !pack) notFound();
  const { release } = data;
  const first = release.scenarios.find(s => s.tour?.length) ?? release.scenarios[0]!;
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/packs/' + packId, label: release.title }]} />
    <main id="main" className="pack">
      <p className="pack__labels">{release.fictional && <span className="status-label status-label--unverified">Fictional law</span>} {release.frameworks.map(f => <span key={f.id} className="status-label status-label--draft">{f.label} · {f.status === 'enacted' ? 'recorded as in force' : f.status + ', not enacted'}</span>)}</p>
      <h1>{release.title}</h1>
      <p className="intro">{release.summary}</p>
      <div className="planning-warning" role="note">{release.disclaimers.map(d => <p key={d}>{d}</p>)}</div>
      <p><a className="lm-button lm-button--primary" href={'/packs/' + packId + '/scenarios/' + first.id}>Start: {first.question}</a></p>

      <section aria-labelledby="scenarios-h">
        <h2 id="scenarios-h">Scenarios</h2>
        <ol className="scenario-list">{release.scenarios.map(s => <li key={s.id}><h3><a href={'/packs/' + packId + '/scenarios/' + s.id}>{s.title}</a></h3><p>{s.question}</p>{s.unresolved.length > 0 && <p className="muted small">Includes an unresolved question.</p>}</li>)}</ol>
      </section>

      <section aria-labelledby="frameworks-h">
        <h2 id="frameworks-h">What is modeled</h2>
        {release.frameworks.map(f => {
          const cov = release.coverage.find(c => c.frameworkId === f.id)!;
          const doc = release.documents.find(d => d.versionId === f.versionId)!;
          return <article key={f.id} className="framework-card">
            <h3>{f.label}</h3>
            <p className="muted">{f.role === 'baseline' ? 'Baseline dated ' + date(f.asOf) : 'Proposal'} · jurisdiction {f.jurisdiction} · version {f.version}</p>
            <p>{cov.statement}</p>
            <p><a href={'/packs/' + packId + '/sources/' + doc.sourceId}>Read the source text</a> · {f.rules.length} executable rules</p>
            {f.gaps.length > 0 && <ul>{f.gaps.map(g => <li key={g}>{g}</li>)}</ul>}
          </article>;
        })}
        {release.interpretations.length > 0 && <><h3>Open interpretation questions</h3><ul>{release.interpretations.map(i => <li key={i.id}>{i.question} {i.chosen ? '(an editor chose a reading)' : '(left unresolved; scenarios show each reading)'}</li>)}</ul></>}
      </section>

      <section aria-labelledby="more-h">
        <h2 id="more-h">Go deeper</h2>
        <ul className="link-list">
          <li><a href={'/packs/' + packId + '/glossary'}>Glossary</a></li>
          {release.documents.map(d => <li key={d.sourceId}><a href={'/packs/' + packId + '/sources/' + d.sourceId}>Source: {d.title}</a></li>)}
          {release.scenarios.some(s => s.workload) && <li><a href={'/packs/' + packId + '/stress'}>Stress test: workload and capacity</a></li>}
          <li><a href={'/search?pack=' + packId}>Search this model</a></li>
        </ul>
      </section>

      <section aria-labelledby="versions-h">
        <h2 id="versions-h">Versions</h2>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Release versions table"><table><thead><tr><th scope="col">Release</th><th scope="col">Published</th><th scope="col">Status</th><th scope="col">Signature</th><th scope="col">Digest</th></tr></thead>
          <tbody>{pack.releases.map(r => <tr key={r.manifestDigest}><th scope="row">{r.status === 'withdrawn' ? r.label : <a href={'/packs/' + packId + '/scenarios/' + first.id + '?r=' + r.manifestDigest}>{r.label}</a>}</th><td>{date(r.publishedAt)}</td><td>{r.status}{r.note ? ': ' + r.note : ''}</td><td>{r.signed ? 'Signed' : 'Unsigned'}</td><td><code title={r.manifestDigest}>{r.manifestDigest.slice(0, 12)}…</code></td></tr>)}</tbody></table></div>
        <p className="muted small">Each release is immutable and content-addressed. Links that name a release keep using it; withdrawn releases are shown as withdrawn instead of being replaced silently.</p>
      </section>
    </main>
    <SiteFooter />
  </>;
}
