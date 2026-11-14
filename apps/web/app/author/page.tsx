import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../components/SiteHeader.tsx';
import { AuthorHome } from '../components/author/AuthorHome.tsx';

export const metadata: Metadata = { title: 'Authoring | Law Machine', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default function AuthorPage() {
  return <><SiteHeader crumbs={[{ href: '/author', label: 'Authoring' }]} /><main id="main" className="author"><AuthorHome /></main><SiteFooter /></>;
}
