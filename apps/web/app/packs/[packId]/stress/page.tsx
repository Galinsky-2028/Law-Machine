import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { loadPack, readCatalog, readRelease, readTrust } from '../../../lib/server/releases.ts';
import { SiteFooter, SiteHeader } from '../../../components/SiteHeader.tsx';
import { StressView } from '../../../components/StressView.tsx';

type Props = { params: Promise<{ packId: string }> };
export const dynamicParams = true;
export const revalidate = 60;
export function generateStaticParams() { return readCatalog().packs.filter(p => readRelease(p.packId)!.release.scenarios.some(s => s.workload)).map(p => ({ packId: p.packId })); }
export const metadata: Metadata = { title: 'Stress test | Law Machine' };

export default async function StressPage({ params }: Props) {
  const { packId } = await params;
  const data = await loadPack(packId);
  const entry = data?.catalog;
  if (!data || !entry?.current || !data.release.scenarios.some(s => s.workload)) notFound();
  const scenarios = data.release.scenarios.filter(s => s.workload).map(s => ({ id: s.id, title: s.title }));
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/packs/' + packId, label: data.release.title }, { href: '/packs/' + packId + '/stress', label: 'Stress test' }]} />
    <main id="main" className="stress">
      <p className="eyebrow">ADVANCED · ILLUSTRATIVE ASSUMPTIONS</p>
      <h1>What if the office is overloaded?</h1>
      <p className="intro">Run the same legal model many times with a busy queue. The law and its deadline stay fixed; only the modeled workload changes. Results show variation under the stated assumptions, not a forecast for any real office.</p>
      <Suspense fallback={<p role="status">Loading…</p>}><StressView packId={packId} digest={entry.current} trust={readTrust()} scenarios={scenarios} base={data.base} /></Suspense>
    </main>
    <SiteFooter />
  </>;
}
