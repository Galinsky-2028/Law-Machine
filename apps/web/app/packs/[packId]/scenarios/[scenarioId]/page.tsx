import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { withdrawnNotice } from '../../../../lib/server/published.ts';
import { WithdrawnNotice } from '../../../../components/WithdrawnNotice.tsx';
import { loadPack, readCatalog, readRelease, readTrust } from '../../../../lib/server/releases.ts';
import { runPackScenario } from '../../../../../../../packages/simulation/src/pack-engine.ts';
import { SiteFooter, SiteHeader } from '../../../../components/SiteHeader.tsx';
import { Explorer } from '../../../../components/explorer/Explorer.tsx';

type Props = { params: Promise<{ packId: string; scenarioId: string }> };
export const dynamicParams = true;
export const revalidate = 60;
export function generateStaticParams() {
  return readCatalog().packs.flatMap(p => readRelease(p.packId)!.release.scenarios.map(s => ({ packId: p.packId, scenarioId: s.id })));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { packId, scenarioId } = await params;
  const s = (await loadPack(packId))?.release.scenarios.find(x => x.id === scenarioId);
  return { title: (s?.title ?? 'Scenario') + ' | Law Machine', description: s?.question ?? '' };
}
const date = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export default async function ScenarioPage({ params }: Props) {
  const { packId, scenarioId } = await params;
  const data = await loadPack(packId);
  const entry = data?.catalog;
  const scenario = data?.release.scenarios.find(s => s.id === scenarioId);
  if (!data) { const notice = await withdrawnNotice(packId); if (notice) return <WithdrawnNotice notice={notice} />; }
  if (!data || !entry || !scenario) notFound();
  const { release } = data;
  // Server-rendered reading of the published default run, so the page is useful before or without JavaScript.
  const defaultFramework = (release.frameworks.find(f => f.role === 'proposal') ?? release.frameworks[0]!);
  const preview = runPackScenario(release, defaultFramework.id, scenario);
  const assumptions = scenario.assumptions.map(id => release.assumptions.find(a => a.id === id)!).filter(Boolean);
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/packs/' + packId, label: release.title }, { href: '/packs/' + packId + '/scenarios/' + scenarioId, label: scenario.title }]} />
    <main id="main" className="scenario">
      <p className="eyebrow">{release.fictional ? 'FICTIONAL LAW · ' : ''}HYPOTHETICAL SCENARIO</p>
      <h1>{scenario.question}</h1>
      <p className="intro">{scenario.summary}</p>
      {scenario.learn.length > 0 && <ul className="learn">{scenario.learn.map(l => <li key={l}>{l}</li>)}</ul>}
      <Suspense fallback={<p className="status-notice" role="status">Loading the interactive model…</p>}>
        <Explorer packId={packId} scenarioId={scenarioId} current={entry.current!} releases={entry.releases} trust={readTrust()} base={data.base} />
      </Suspense>
      <noscript>
        <section className="static-sequence">
          <h2>Step by step under {defaultFramework.label}</h2>
          <ol>{preview.events.map(e => <li key={e.id}><strong>{date(e.date)}</strong>: {e.label}{e.outcome === 'breached' ? ' (breached)' : e.outcome === 'unknown' ? ' (unresolved)' : ''}</li>)}</ol>
        </section>
      </noscript>
      <section aria-labelledby="assumptions-h" className="assumptions">
        <h2 id="assumptions-h">Assumptions in this scenario</h2>
        <ul>{assumptions.map(a => <li key={a.id}><strong>{a.label}</strong> ({a.classification}). {a.description} {a.limitations.join(' ')}</li>)}</ul>
        {scenario.unknownFacts.length > 0 && <><h3>Unknown facts</h3><ul>{scenario.unknownFacts.map(u => <li key={u.factId}>{release.facts.find(f => f.id === u.factId)?.label}: {u.reason}</li>)}</ul></>}
        {scenario.unresolved.length > 0 && <><h3>Unresolved questions</h3><ul>{scenario.unresolved.map(u => <li key={u}>{u}</li>)}</ul></>}
      </section>
    </main>
    <SiteFooter />
  </>;
}
