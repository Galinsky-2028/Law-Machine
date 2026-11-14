'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { PackRelease, TrustStore } from '../../../../packages/contracts/src/index.ts';
import type { StressResult } from '../../../../packages/simulation/src/pack-analysis.ts';
import { MAX_STRESS_SAMPLES } from '../../../../packages/simulation/src/pack-analysis.ts';
import { PackEngineClient } from '../lib/pack-client.ts';

export function StressView({ packId, digest, trust, scenarios }: { packId: string; digest: string; trust: TrustStore; scenarios: readonly { id: string; title: string }[] }) {
  const search = useSearchParams();
  const client = useRef<PackEngineClient | null>(null);
  const [release, setRelease] = useState<PackRelease | null>(null);
  const [scenarioId, setScenarioId] = useState(scenarios.find(s => s.id === search.get('scenario'))?.id ?? scenarios[0]?.id ?? '');
  const [frameworkId, setFrameworkId] = useState('');
  const [form, setForm] = useState({ samples: 100, arrivalsPerDay: 6, workers: 1, unitsPerWorkerDay: 8, outageDays: '' });
  const [result, setResult] = useState<StressResult | null>(null);
  const [status, setStatus] = useState('Verifying release…');
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const engine = new PackEngineClient();
    client.current = engine;
    void engine.request('load', generation => ({ type: 'load', generation, base: '/releases', packId, digest, trust })).then(r => {
      if (r?.type === 'loaded') { setRelease(r.release); setFrameworkId((r.release.frameworks.find(f => f.role === 'proposal') ?? r.release.frameworks[0]!).id); setStatus(''); }
      else if (r?.type === 'error') setStatus('Release could not be verified: ' + r.code);
    });
    return () => engine.dispose();
  }, [packId, digest, trust]);
  useEffect(() => {
    const w = release?.scenarios.find(s => s.id === scenarioId)?.workload;
    if (w) setForm(f => ({ ...f, arrivalsPerDay: w.arrivalsPerDay, workers: w.workers, unitsPerWorkerDay: w.unitsPerWorkerDay }));
  }, [release, scenarioId]);
  const run = async () => {
    if (!client.current) return;
    const outageDays = form.outageDays.split(/[ ,]+/).filter(Boolean).map(Number);
    if (outageDays.some(n => !Number.isSafeInteger(n) || n < 0 || n > 365)) { setStatus('Outage days must be whole numbers of days after the scenario start (0–365), separated by commas.'); return; }
    setRunning(true); setResult(null); setStatus('Running ' + form.samples + ' seeded runs…');
    const r = await client.current.request('stress', generation => ({ type: 'stress', generation, scenarioId, params: {}, request: { frameworkId, samples: form.samples, arrivalsPerDay: form.arrivalsPerDay, workers: form.workers, unitsPerWorkerDay: form.unitsPerWorkerDay, outageDays } }));
    if (r === null) return;
    setRunning(false);
    if (r?.type === 'stress') { setResult(r.result); setStatus('Done.'); }
    else if (r?.type === 'error') setStatus(r.code === 'CANCELLED' ? 'Cancelled.' : r.code === 'STRESS_REQUEST_OUT_OF_BOUNDS' ? 'Those settings are outside the supported limits.' : 'Could not run: ' + r.message);
  };
  const cancel = () => { client.current?.cancelKind('stress'); setRunning(false); setStatus('Cancelled. No partial result is shown.'); };
  const num = (key: 'samples' | 'arrivalsPerDay' | 'workers' | 'unitsPerWorkerDay', label: string, min: number, max: number, help: string) =>
    <div className="control"><label htmlFor={'s-' + key} className="control__label">{label}</label><input id={'s-' + key} type="number" min={min} max={max} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: Math.max(min, Math.min(max, Number(e.target.value) || 0)) }))} aria-describedby={'s-' + key + '-h'} /><p id={'s-' + key + '-h'} className="control__help">{help} ({min}–{max})</p></div>;
  const max = result ? Math.max(1, ...result.histogram.map(h => h.count)) : 1;
  return <div className="stress-view">
    <form className="controls" onSubmit={e => { e.preventDefault(); void run(); }}>
      <div className="control"><label htmlFor="s-scenario" className="control__label">Scenario</label><select id="s-scenario" value={scenarioId} onChange={e => setScenarioId(e.target.value)}>{scenarios.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></div>
      {release && <div className="control"><label htmlFor="s-fw" className="control__label">Legal framework</label><select id="s-fw" value={frameworkId} onChange={e => setFrameworkId(e.target.value)}>{release.frameworks.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>}
      {num('samples', 'Number of runs', 1, MAX_STRESS_SAMPLES, 'More runs show more variation; the limit keeps the page responsive')}
      {num('arrivalsPerDay', 'Average new items per day', 0, 500, 'Other work arriving in the same queue')}
      {num('workers', 'Staff', 0, 200, 'People processing the queue')}
      {num('unitsPerWorkerDay', 'Work each person finishes per business day', 0, 1000, 'In work units; each item needs a fixed number')}
      <div className="control"><label htmlFor="s-out" className="control__label">Outage days (optional)</label><input id="s-out" value={form.outageDays} onChange={e => setForm(f => ({ ...f, outageDays: e.target.value.slice(0, 200) }))} placeholder="e.g. 1, 2" aria-describedby="s-out-h" /><p id="s-out-h" className="control__help">Days after the scenario start when no work is done.</p></div>
      <button type="submit" className="lm-button lm-button--primary" disabled={!release || running}>Run stress test</button>
      {running && <button type="button" className="lm-button lm-button--secondary" onClick={cancel}>Cancel</button>}
      <p role="status" className="small">{status}</p>
    </form>
    {result && <section className="stress-result" aria-labelledby="sr-h">
      <h2 id="sr-h">Timeliness across {result.samples} runs</h2>
      <p>The legal due date stays <strong>{result.legalDue ?? 'unresolved'}</strong> in every run. Met: {result.satisfied}. Breached: {result.breached}. Not performed within the horizon: {result.neverPerformed}.</p>
      <figure>
        <figcaption>How late the duty was performed (business days after the legal due date)</figcaption>
        <svg viewBox={'0 0 520 ' + (result.histogram.length * 34 + 10)} role="img" aria-labelledby="sr-desc" className="histogram">
          <desc id="sr-desc">{result.histogram.map(h => h.bucket + ': ' + h.count + ' runs').join('; ')}</desc>
          {result.histogram.map((h, i) => <g key={h.bucket} transform={'translate(0 ' + (i * 34 + 5) + ')'}><text x="0" y="17">{h.bucket}</text><rect x="190" y="2" height="22" width={Math.max(2, (h.count / max) * 280)} className={i === 0 ? 'bar bar--ok' : 'bar bar--late'} /><text x={196 + (h.count / max) * 280} y="17">{h.count}</text></g>)}
        </svg>
      </figure>
      <table className="visually-hidden"><caption>Histogram data</caption><thead><tr><th scope="col">Lateness</th><th scope="col">Runs</th></tr></thead><tbody>{result.histogram.map(h => <tr key={h.bucket}><td>{h.bucket}</td><td>{h.count}</td></tr>)}</tbody></table>
      <h2>Method and assumptions</h2><p>{result.methodology}</p><ul>{result.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
      <p className="muted small">Lateness median {result.lateness.median ?? '—'}, maximum {result.lateness.max ?? '—'} business days. Unit: {result.unit}. No probability claim is made.</p>
    </section>}
  </div>;
}
