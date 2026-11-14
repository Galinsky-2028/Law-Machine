'use client';
import { useId } from 'react';
import type { PackRelease, ScenarioSpec } from '../../../../../packages/contracts/src/index.ts';
import type { ParameterIssue, ParameterValue } from '../../../../../packages/simulation/src/pack-analysis.ts';

/** Schema-driven controls: only authored, bounded inputs can be changed. */
export function Controls({ release, scenario, values, issues, disabledRules, frameworkId, onChange, onReset, onToggleRule }: {
  release: PackRelease; scenario: ScenarioSpec; values: Readonly<Record<string, ParameterValue>>; issues: readonly ParameterIssue[];
  disabledRules: readonly string[]; frameworkId: string; onChange: (id: string, value: ParameterValue) => void; onReset: () => void; onToggleRule: (ruleId: string) => void;
}) {
  const uid = useId();
  const framework = release.frameworks.find(f => f.id === frameworkId);
  return <section className="controls" aria-labelledby={uid + 'h'}>
    <h2 id={uid + 'h'}>Change a circumstance</h2>
    <p className="muted small">Changes stay in your browser. They create a labeled experiment, not the published model.</p>
    {scenario.parameters.map(p => {
      const id = uid + p.id;
      const issue = issues.find(i => i.parameterId === p.id);
      const v = values[p.id];
      const describedBy = id + '-help' + (issue ? ' ' + id + '-err' : '');
      const assumption = p.assumptionId ? release.assumptions.find(a => a.id === p.assumptionId) : null;
      let control: React.ReactNode;
      if (p.control === 'integer') control = <input id={id} type="number" inputMode="numeric" min={p.min} max={p.max} step={1} value={typeof v === 'number' ? v : ''} aria-describedby={describedBy} aria-invalid={!!issue}
        onChange={e => onChange(p.id, e.target.value === '' ? null : Number(e.target.value))} />;
      else if (p.control === 'boolean') control = <input id={id} type="checkbox" checked={v === true} aria-describedby={describedBy} onChange={e => onChange(p.id, e.target.checked)} />;
      else if (p.control === 'tristate') control = <fieldset className="tristate" aria-describedby={describedBy}><legend className="visually-hidden">{p.label}</legend>
        {([['Yes', true], ['No', false], ['Unknown', null]] as const).map(([label, value]) => <label key={label}><input type="radio" name={id} checked={v === value} onChange={() => onChange(p.id, value)} /> {label}</label>)}</fieldset>;
      else control = <select id={id} value={typeof v === 'string' ? v : ''} aria-describedby={describedBy} onChange={e => onChange(p.id, e.target.value === '' ? null : e.target.value)}>
        {p.target.kind === 'interpretation' && <option value="">Unresolved — no reading chosen</option>}
        {p.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      return <div key={p.id} className={'control control--' + p.control + (issue ? ' has-error' : '')}>
        {p.control === 'tristate' ? <span className="control__label">{p.label}</span> : <label htmlFor={id} className="control__label">{p.label}{p.unit ? ' (' + p.unit + ')' : ''}</label>}
        {control}
        <p id={id + '-help'} className="control__help">{p.help}{assumption ? ' Assumption: ' + assumption.label + '.' : ''}{p.control === 'integer' ? ' Allowed: ' + p.min + ' to ' + p.max + '.' : ''}</p>
        {issue && <p id={id + '-err'} className="control__error" role="alert">{issue.message}</p>}
      </div>;
    })}
    <button type="button" className="lm-button lm-button--secondary" onClick={onReset}>Reset to the published scenario</button>
    {framework && <details className="sandbox">
      <summary>Experiment: switch off a rule</summary>
      <p className="muted small">Switching off a rule creates a sandbox model. It is clearly labeled, cannot be shared as the published model, and is not exported as a verified result.</p>
      <ul>{framework.rules.map(r => <li key={r.id}><label><input type="checkbox" checked={!disabledRules.includes(r.id)} onChange={() => onToggleRule(r.id)} /> {r.effect.summary}</label></li>)}</ul>
    </details>}
  </section>;
}
