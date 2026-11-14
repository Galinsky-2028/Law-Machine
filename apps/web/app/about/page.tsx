import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../components/SiteHeader.tsx';

export const metadata: Metadata = { title: 'How it works | Law Machine' };
export default function About() {
  return <>
    <SiteHeader crumbs={[{ href: '/about', label: 'How it works' }]} />
    <main id="main" className="about prose">
      <h1>How Law Machine works</h1>
      <h2>From words to steps</h2>
      <p>Each model starts from the exact text of a source, preserved byte for byte and fingerprinted. Editors write executable rules that each quote the words they rely on. The release builder refuses any rule whose quote is not found verbatim in the pinned text, and every provision is labeled as modeled, explanation only, ambiguous or unsupported.</p>
      <h2>Law is not behavior</h2>
      <p>A rule can create a duty with a deadline. Whether anyone actually does the work comes from a separate, labeled assumption that you can change. That is why a duty can be breached: the law requires two days, the modeled office takes five, and the model records the breach without pretending the deadline guaranteed anything.</p>
      <h2>Unknown stays unknown</h2>
      <p>If a fact is unknown, rules that depend on it stay unresolved instead of quietly becoming “no”. If two provisions point different ways, the model shows the conflict and lets you choose a reading; it does not pick the one that looks best.</p>
      <h2>Proposals are not law</h2>
      <p>A proposal only runs under an explicit assumption that it was enacted, and every view says so. Comparisons hold the facts and behavior assumptions fixed and change only the legal framework.</p>
      <h2>Reproducible and verifiable</h2>
      <p>Releases are immutable and content-addressed, signed by the publisher key listed in the public trust file, and checked in your browser before anything runs. Simulations run in your browser with a deterministic engine and calendar; the same inputs always give the same trace, and the server can recompute a downloaded result to confirm it.</p>
      <h2>Limits</h2>
      <ul>
        <li>The models published today use fictional law written for demonstration. The real federal electronic-filing bill is not available here until its authentic text and dated official baseline sources are supplied.</li>
        <li>Nothing here is legal advice, accepts a filing, issues a receipt or calculates anyone's actual deadline.</li>
        <li>Stress tests show variation under stated assumptions, not forecasts or probabilities.</li>
        <li>Security testing and code review have been done with AI assistance. No independent human audit or certification is claimed.</li>
      </ul>
    </main>
    <SiteFooter />
  </>;
}
