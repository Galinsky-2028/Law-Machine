import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../../../components/SiteHeader.tsx';
import { Workbench } from '../../../../components/author/Workbench.tsx';

export const metadata: Metadata = { title: 'Workbench | Law Machine authoring', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default async function WorkbenchPage({ params }: { params: Promise<{ org: string; doc: string }> }) {
  const { org, doc } = await params;
  return <><SiteHeader crumbs={[{ href: '/author', label: 'Authoring' }, { href: '/author/' + org, label: 'Organization' }, { href: '#', label: 'Workbench' }]} /><main id="main" className="author workbench-main"><Workbench org={org} doc={doc} /></main><SiteFooter /></>;
}
