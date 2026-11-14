export function SiteHeader({ crumbs = [] }: { crumbs?: readonly { href: string; label: string }[] }) {
  return <header className="site-header">
    <a className="site-header__brand" href="/">Law Machine</a>
    <nav aria-label="Main">
      <a href="/">Models</a>
      <a href="/search">Search</a>
      <a href="/about">How it works</a>
      <a href="/verify">Verify a result</a>
    </nav>
    {crumbs.length > 0 && <nav aria-label="Breadcrumb" className="crumbs"><ol>{crumbs.map((c, i) => <li key={c.href}>{i === crumbs.length - 1 ? <span aria-current="page">{c.label}</span> : <a href={c.href}>{c.label}</a>}</li>)}</ol></nav>}
  </header>;
}
export function SiteFooter() {
  return <footer className="site-footer">
    <p>Law Machine explains hypothetical scenarios with sources. It does not accept filings, issue receipts, calculate anyone's real deadline or give legal advice. Proposals are never shown as enacted law.</p>
    <p><a href="/about">Method and limitations</a> · <a href="/api/v1/catalog">Public catalog API</a> · <a href="/author">Authoring</a> · Developer previews: <a href="/design">design</a>, <a href="/worker-preview">worker</a>, <a href="/planning-preview">electronic-filing planning</a></p>
  </footer>;
}
