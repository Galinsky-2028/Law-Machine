import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../components/SiteHeader.tsx';
import { VerifyBox } from '../components/VerifyBox.tsx';

export const metadata: Metadata = { title: 'Verify a result | Law Machine' };
export default function VerifyPage() {
  return <>
    <SiteHeader crumbs={[{ href: '/', label: 'Models' }, { href: '/verify', label: 'Verify a result' }]} />
    <main id="main" className="verify">
      <h1>Verify a downloaded result</h1>
      <p className="intro">Choose a JSON file downloaded from a scenario. The server reruns the pinned model with the same inputs and checks that the outcome matches. A result that was edited, or that comes from a sandbox model, does not verify.</p>
      <VerifyBox />
      <p className="muted small">Your file is sent to this server only to recompute it and is not stored. It contains the scenario settings, not personal information.</p>
    </main>
    <SiteFooter />
  </>;
}
