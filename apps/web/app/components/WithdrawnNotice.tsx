import { SiteFooter, SiteHeader } from './SiteHeader.tsx';
export function WithdrawnNotice({ notice }: { notice: { title: string; note: string | null; withdrawnAt: string } }) {
  return <><SiteHeader /><main id="main"><p className="eyebrow">WITHDRAWN</p><h1>{notice.title}</h1>
    <div className="planning-warning" role="alert"><strong>This model was withdrawn on {notice.withdrawnAt}.</strong><p>{notice.note ?? 'The publisher withdrew it.'} It is not shown with a different model instead.</p></div>
    <p><a href="/">Browse current models</a></p></main><SiteFooter /></>;
}
