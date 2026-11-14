'use client';
import type { PackRelease } from '../../../../../packages/contracts/src/index.ts';
import type { PackComparison } from '../../../../../packages/simulation/src/pack-analysis.ts';
import { addDays } from '../../../../../packages/simulation/src/pack-engine.ts';
import { DUTY_LABEL, formatDate, humanize } from './labels.ts';

/** Same circumstances, two legal frameworks. Behavior inputs are identical on both sides. */
export function ComparePanel({ release, comparison, startDate, onSelectCheckpoint }: { release: PackRelease; comparison: PackComparison; startDate: string; onSelectCheckpoint: (frameworkId: string, key: string) => void }) {
  const baseline = release.frameworks.find(f => f.role === 'baseline')!;
  const proposal = release.frameworks.find(f => f.role === 'proposal')!;
  const date = (t: number | null) => t === null ? '—' : formatDate(addDays(startDate, t));
  const assumptions = new Map(comparison.assumptionNotes.map(n => [n.semanticKey, n.assumptionIds]));
  const cell = (p: PackComparison['comparison']['changes'][number]['baseline']) => p ? <>
    {p.eventTick !== null && <span>{date(p.eventTick)}</span>}
    {p.dueTick !== null && <span className="muted"> · due {date(p.dueTick)}</span>}
    {p.dutyState !== 'none' && <span className={'duty-state duty-state--' + p.dutyState}> · {DUTY_LABEL[p.dutyState]}</span>}
    {p.unresolved.length > 0 && <span className="duty-state duty-state--unknown"> · unresolved</span>}
  </> : <span className="muted">Does not occur</span>;
  return <section className="compare" aria-labelledby="compare-title">
    <h2 id="compare-title">What changes between the two frameworks</h2>
    <p className="compare__note">Same hypothetical facts and the same behavior assumptions under both. Only the legal framework changes. {comparison.comparison.hypotheticalEnactment && 'The draft is run as if enacted; it is not current law.'} Baseline dated {formatDate(baseline.asOf)}.</p>
    <ul className="compare__headline">{comparison.headline.map(h => <li key={h}>{h}</li>)}</ul>
    {comparison.comparison.state === 'unresolved' && <p className="unresolved-note" role="note">Some results remain unresolved under at least one framework. They are not counted as differences or similarities.</p>}
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Checkpoint comparison table"><table>
      <caption className="visually-hidden">Checkpoint comparison</caption>
      <thead><tr><th scope="col">Step</th><th scope="col">{baseline.label}</th><th scope="col">{proposal.label}</th><th scope="col">Change</th></tr></thead>
      <tbody>{comparison.comparison.changes.map(c => <tr key={c.semanticKey} className={c.kind === 'unchanged' ? '' : 'is-changed'}>
        <th scope="row">{humanize(c.semanticKey)}</th>
        <td><button type="button" className="linklike" onClick={() => onSelectCheckpoint(baseline.id, c.semanticKey)} disabled={!c.baseline}>{cell(c.baseline)}</button></td>
        <td><button type="button" className="linklike" onClick={() => onSelectCheckpoint(proposal.id, c.semanticKey)} disabled={!c.proposal}>{cell(c.proposal)}</button></td>
        <td>{c.kind === 'unchanged' ? 'Same' : c.kind === 'added' ? 'Only in the draft' : c.kind === 'removed' ? 'Only in the baseline' : c.reasons.map(r => humanize(r.toLowerCase())).join(', ')}
          {(assumptions.get(c.semanticKey) ?? []).length > 0 && <p className="muted small">Depends on: {(assumptions.get(c.semanticKey) ?? []).map(id => release.assumptions.find(a => a.id === id)?.label ?? id).join(', ')}</p>}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
