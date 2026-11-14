import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveSaved } from '../../lib/server/saved.ts';
import { SiteFooter, SiteHeader } from '../../components/SiteHeader.tsx';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Saved scenario | Law Machine', robots: { index: false, follow: false } };
export default async function Saved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const saved = await resolveSaved(id).catch(() => null);
  if (saved?.href && saved.releaseStatus !== 'withdrawn') redirect(saved.href);
  return <><SiteHeader /><main id="main"><h1>Saved scenario unavailable</h1>
    <p className="intro">{saved?.releaseStatus === 'withdrawn' ? 'This saved scenario uses a release the publisher has withdrawn. It is not shown with a different model.' : 'This link has expired, was deleted, or never existed.'}</p>
    <p><a href="/">Browse current models</a></p></main><SiteFooter /></>;
}
