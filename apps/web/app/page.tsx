import { readCatalog } from './lib/server/releases.ts';
import { SiteFooter, SiteHeader } from './components/SiteHeader.tsx';

export default function Home() {
  const catalog = readCatalog();
  return <>
    <SiteHeader />
    <main id="main" className="home">
      <p className="eyebrow">LAW MACHINE</p>
      <h1>See how a law works.</h1>
      <p className="intro">Follow a claim, an application or a dollar through the institutions that handle it. See who must act and when, what happens when they don't, and the exact words behind every step. Then compare what a proposal would change.</p>
      <section aria-labelledby="start" className="home__start">
        <h2 id="start">Start with one question</h2>
        <a className="start-card" href="/packs/meridian-claims/scenarios/wrong-agency">
          <span className="start-card__q">What happens when a claim goes to the wrong agency?</span>
          <span className="start-card__how">A guided journey through a fictional example · about 3 minutes · no account</span>
        </a>
      </section>
      <section aria-labelledby="models">
        <h2 id="models">Models you can explore</h2>
        <ul className="pack-grid">{catalog.packs.map(p => <li key={p.packId} className="pack-card">
          <p className="pack-card__labels"><span className="status-label status-label--unverified">{p.fictional ? 'Fictional law' : 'Sourced law'}</span> <span className="status-label status-label--draft">{p.statusLabel.replace(/^Fictional · /, '')}</span></p>
          <h3><a href={'/packs/' + p.packId}>{p.title}</a></h3>
          <p>{p.question}</p>
          <p className="muted small">{p.scenarioCount} scenarios · release {p.releases.find(r => r.manifestDigest === p.current)?.label}{p.releases.find(r => r.manifestDigest === p.current)?.signed ? ' · signed' : ''}</p>
        </li>)}</ul>
        {catalog.unavailable.map(u => <div key={u.packId} className="planning-warning" role="note"><strong>{u.title}: not available yet.</strong><p>{u.reason}</p><p><a href="/planning-preview">See the planned scenarios (no verified law)</a></p></div>)}
      </section>
      <section aria-labelledby="ways">
        <h2 id="ways">Three ways in</h2>
        <ol className="ways"><li><strong>Follow one case.</strong> Play a scenario step by step and stop anywhere to ask why.</li><li><strong>Explore the system.</strong> Read the sources, see which rules are modeled, and look up terms.</li><li><strong>Change a circumstance.</strong> Adjust facts or agency behavior, or compare current law with a proposal.</li></ol>
      </section>
    </main>
    <SiteFooter />
  </>;
}
