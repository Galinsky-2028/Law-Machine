'use client';
import type { PackRelease } from '../../../../../packages/contracts/src/index.ts';
import type { PackRun } from '../../../../../packages/simulation/src/pack-engine.ts';
import { explainEvent } from '../../../../../packages/simulation/src/pack-analysis.ts';
import { BASIS_LABEL, CATEGORY_LABEL, DUTY_LABEL, formatDate, type Selection } from './labels.ts';

function Quote({ text, quote }: { text: string; quote: string }) {
  const at = text.indexOf(quote);
  if (at < 0) return <p className="provision-text">{text}</p>;
  return <p className="provision-text">{text.slice(0, at)}<mark>{quote}</mark>{text.slice(at + quote.length)}</p>;
}
const sourceHref = (release: PackRelease, versionId: string, provisionId: string, digest: string) => {
  const doc = release.documents.find(d => d.versionId === versionId);
  return doc ? '/packs/' + release.packId + '/sources/' + doc.sourceId + '?r=' + digest + '#' + provisionId : '#';
};

/** Everything shown here is read from the executed trace and the pinned release. */
export function Inspector({ release, run, digest, selection, onSelect, onClose }: {
  release: PackRelease; run: PackRun; digest: string; selection: Selection | null; onSelect: (s: Selection) => void; onClose?: () => void;
}) {
  const actors = new Map(release.actors.map(a => [a.id, a]));
  if (!selection) return <aside className="inspector" aria-label="Inspector"><h2>Inspector</h2><p>Select a step, an institution on the map, or a source to see why it happens and where the rule comes from.</p></aside>;
  let body: React.ReactNode = null, title = '';
  if (selection.kind === 'event') {
    const event = run.events.find(e => e.id === selection.id);
    if (!event) return <aside className="inspector" aria-label="Inspector"><p>This step is not part of the current run.</p></aside>;
    const why = explainEvent(release, run, event.id);
    const duty = event.dutyId ? run.duties.find(d => d.id === event.dutyId) : null;
    title = event.label;
    body = <>
      <p className="inspector__labels"><span className={'badge badge--' + event.category}>{CATEGORY_LABEL[event.category]}</span> <span className="badge badge--basis">{BASIS_LABEL[event.basis]}</span> <span>{formatDate(event.date)}</span></p>
      <p className={'inspector__plain' + (why.state === 'unresolved' ? ' is-unresolved' : '')}>{why.plain}</p>
      {why.detail && <details className="inspector__detail"><summary>More detail</summary><p>{why.detail}</p></details>}
      {duty && <dl className="inspector__duty">
        <div><dt>Who owes it</dt><dd>{actors.get(duty.actorId)?.name ?? duty.actorId}</dd></div>
        <div><dt>Legal due date</dt><dd>{duty.deadline === 'none' ? 'No deadline stated' : duty.deadline === 'unresolved' ? 'Unresolved' : formatDate(duty.dueDate)}</dd></div>
        <div><dt>Performed</dt><dd>{duty.performedDate ? formatDate(duty.performedDate) : 'Not performed in this run'}</dd></div>
        <div><dt>Status</dt><dd className={'duty-state duty-state--' + duty.state}>{DUTY_LABEL[duty.state]}</dd></div>
      </dl>}
      {why.exceptions.length > 0 && <section><h3>Exception applied</h3><ul>{why.exceptions.map(x => <li key={x.id}>{x.label}</li>)}</ul></section>}
      {event.predicates.length > 0 && <section><h3>Facts this rule checked</h3><ul className="facts">{event.predicates.map(p => <li key={p.factId}>{release.facts.find(f => f.id === p.factId)?.label ?? p.factId}: <strong>{p.value === null ? 'unknown' : String(p.value)}</strong></li>)}</ul></section>}
      {why.excerpts.length > 0 && <section><h3>Source</h3>{why.excerpts.map((x, i) => <div key={i} className={'excerpt' + (x.stale ? ' is-stale' : '')}>
        <p className="excerpt__cite"><a href={sourceHref(release, x.versionId, x.provisionId, digest)}>{x.citation}</a> · {x.documentTitle}{x.stale ? ' · stale: the cited text changed' : ''}</p>
        <Quote text={x.text} quote={x.quote} />
        <button type="button" className="linklike" onClick={() => onSelect({ kind: 'provision', versionId: x.versionId, id: x.provisionId })}>Show this provision in the inspector</button>
      </div>)}</section>}
      {why.assumptions.length > 0 && <section><h3>Assumption behind this timing</h3><ul>{why.assumptions.map(a => <li key={a.id}><strong>{a.label}</strong> ({a.classification}). {a.description}</li>)}</ul></section>}
      {why.causalChain.length > 1 && <section><h3>Why did this happen?</h3><ol className="causal">{why.causalChain.map(id => {
        const e = run.events.find(x => x.id === id)!;
        return <li key={id}>{id === event.id ? <strong>{e.label}</strong> : <button type="button" className="linklike" onClick={() => onSelect({ kind: 'event', id })}>{e.label}</button>} <span className="muted">({formatDate(e.date)})</span></li>;
      })}</ol></section>}
    </>;
  } else if (selection.kind === 'actor') {
    const actor = actors.get(selection.id);
    title = actor?.name ?? selection.id;
    const own = run.events.filter(e => e.actorId === selection.id);
    const duties = run.duties.filter(d => d.actorId === selection.id);
    body = <>
      <p>{actor?.description}</p>
      {duties.length > 0 && <section><h3>Duties in this run</h3><ul>{duties.map(d => <li key={d.id}>{release.frameworks.find(f => f.id === run.frameworkId)?.rules.find(r => r.id === d.ruleId)?.effect.summary ?? d.action} — <span className={'duty-state duty-state--' + d.state}>{DUTY_LABEL[d.state]}</span></li>)}</ul></section>}
      <section><h3>Steps involving {actor?.name}</h3>{own.length ? <ul>{own.map(e => <li key={e.id}><button type="button" className="linklike" onClick={() => onSelect({ kind: 'event', id: e.id })}>{formatDate(e.date)}: {e.label}</button></li>)}</ul> : <p>None in this run.</p>}</section>
    </>;
  } else if (selection.kind === 'provision') {
    const doc = release.documents.find(d => d.versionId === selection.versionId);
    const p = doc?.provisions.find(x => x.id === selection.id);
    title = p ? p.citation : 'Provision';
    const users = release.frameworks.flatMap(f => f.rules.filter(r => r.sourceRefs.some(s => s.provisionId === selection.id && s.versionId === selection.versionId)).map(r => ({ f, r })));
    body = p && doc ? <>
      <p className="muted">{doc.title} · version {doc.versionId}</p>
      <p className="provision-text">{p.text}</p>
      <p><a href={sourceHref(release, doc.versionId, p.id, digest)}>Open in the source explorer</a></p>
      {users.length > 0 && <section><h3>Rules that cite it</h3><ul>{users.map(({ f, r }) => <li key={f.id + r.id}>{r.effect.summary} <span className="muted">({f.label})</span></li>)}</ul></section>}
    </> : <p>Unavailable.</p>;
  } else if (selection.kind === 'rule') {
    const f = release.frameworks.find(x => x.id === selection.frameworkId);
    const r = f?.rules.find(x => x.id === selection.id);
    title = r?.effect.summary ?? 'Rule';
    const events = run.frameworkId === selection.frameworkId ? run.events.filter(e => e.ruleId === selection.id) : [];
    body = r && f ? <>
      <p>{release.explanations[r.explanationKey]?.plain}</p><p className="muted">{release.explanations[r.explanationKey]?.detail}</p>
      <p className="muted">{f.label} · {r.modal} · acts on “{release.eventLabels[r.trigger] ?? r.trigger}”</p>
      {r.sourceRefs.map((ref, i) => { const doc = release.documents.find(d => d.versionId === ref.versionId); const p = doc?.provisions.find(x => x.id === ref.provisionId); return p ? <div key={i} className="excerpt"><p className="excerpt__cite"><a href={sourceHref(release, ref.versionId, ref.provisionId, digest)}>{p.citation}</a></p><Quote text={p.text} quote={ref.quote} /></div> : null; })}
      {events.length > 0 && <section><h3>In this run</h3><ul>{events.map(e => <li key={e.id}><button type="button" className="linklike" onClick={() => onSelect({ kind: 'event', id: e.id })}>{formatDate(e.date)}: {e.label}</button></li>)}</ul></section>}
    </> : <p>Unavailable.</p>;
  } else {
    title = selection.id.replace(/-/g, ' ');
    const events = run.events.filter(e => e.checkpoint === selection.id);
    body = events.length ? <ul>{events.map(e => <li key={e.id}><button type="button" className="linklike" onClick={() => onSelect({ kind: 'event', id: e.id })}>{formatDate(e.date)}: {e.label}</button></li>)}</ul> : <p>This step does not occur in the current run.</p>;
  }
  return <aside className="inspector" aria-label="Inspector" aria-live="polite">
    <div className="inspector__head"><h2>{title}</h2>{onClose && <button type="button" className="linklike" onClick={onClose}>Close</button>}</div>
    {body}
  </aside>;
}
