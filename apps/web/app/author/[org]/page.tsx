import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../components/SiteHeader.tsx';
import { OrgDashboard } from '../../components/author/OrgDashboard.tsx';

export const metadata: Metadata = { title: 'Organization | Law Machine authoring', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default async function OrgPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  return <><SiteHeader crumbs={[{ href: '/author', label: 'Authoring' }, { href: '/author/' + org, label: 'Organization' }]} /><main id="main" className="author"><OrgDashboard org={org} /></main><SiteFooter /></>;
}
