'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { CatalogRelease, PackRelease, TrustStore } from '../../../../../packages/contracts/src/index.ts';
import type { SignatureCheck } from '../../../../../packages/contracts/src/signing.ts';
import { checkpointSteps, decodeShare, encodeShare, playbackState } from '../../../../../packages/presentation/src/index.ts';
import { defaultParameterValues, exportRun, prepareScenario, type PackComparison, type ParameterValue } from '../../../../../packages/simulation/src/pack-analysis.ts';
import type { PackRun } from '../../../../../packages/simulation/src/pack-engine.ts';
import { PackEngineClient } from '../../lib/pack-client.ts';
import type { PreparedSummary } from '../../lib/pack-protocol.ts';
import { ComparePanel } from './ComparePanel.tsx';
import { Controls } from './Controls.tsx';
import { Inspector } from './Inspector.tsx';
import { DUTY_LABEL, formatDate, type Selection } from './labels.ts';
import { SceneMap } from './SceneMap.tsx';
import { SequenceList } from './SequenceList.tsx';
import { Timeline } from './Timeline.tsx';

type Mode = string; // a framework id, or 'compare'
const SHA = /^[a-f0-9]{64}$/;

export function Explorer({ packId, scenarioId, current, releases, trust, base = '/releases' }: { packId: string; scenarioId: string; current: string; releases: readonly CatalogRelease[]; trust: TrustStore; base?: string }) {
  const search = useSearchParams();
  const query = search.toString();
  const requested = search.get('r');
  const requestedEntry = requested ? releases.find(r => r.manifestDigest === requested) : null;
  const releaseProblem = requested && (!SHA.test(requested) || !requestedEntry) ? 'unknown' : requestedEntry?.status === 'withdrawn' ? 'withdrawn' : null;
  const digest = releaseProblem ? null : (requestedEntry?.manifestDigest ?? current);
  const client = useRef<PackEngineClient | null>(null);
  const [engineMode, setEngineMode] = useState<'worker' | 'main-thread' | null>(null);
  const [loaded, setLoaded] = useState<{ release: PackRelease; manifestDigest: string; releaseId: string; signature: SignatureCheck } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [values, setValues] = useState<Record<string, ParameterValue> | null>(null);
  const [disabled, setDisabled] = useState<Record<string, string[]>>({});
  const [run, setRun] = useState<PackRun | null>(null);
  const [comparison, setComparison] = useState<PackComparison | null>(null);
  const [prepared, setPrepared] = useState<PreparedSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [compareSide, setCompareSide] = useState<string | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [notice, setNotice] = useState('');
  const initialStep = useRef<number | null>(null);

  useEffect(() => {
    const engine = new PackEngineClient();
    client.current = engine;
    setEngineMode(engine.mode);
    return () => engine.dispose();
  }, []);
  // Load and verify the pinned release in the worker.
  useEffect(() => {
    if (!digest || !client.current) return;
    let alive = true;
    setLoaded(null); setError(null);
    void client.current.request('load', generation => ({ type: 'load', generation, base, packId, digest, trust })).then(response => {
      if (!alive || !response) return;
      if (response.type === 'loaded') {
        const scenario = response.release.scenarios.find(s => s.id === scenarioId);
        if (!scenario) { setError('This scenario is not part of the selected release.'); return; }
        const decoded = decodeShare(scenario, query);
        const frameworks = response.release.frameworks.map(f => f.id);
        setLoaded({ release: response.release, manifestDigest: response.manifestDigest, releaseId: response.releaseId, signature: response.signature });
        setMode(decoded.framework && (frameworks.includes(decoded.framework) || (decoded.framework === 'compare' && frameworks.length > 1)) ? decoded.framework : (response.release.frameworks.find(f => f.role === 'proposal') ?? response.release.frameworks[0]!).id);
        setValues({ ...defaultParameterValues(scenario), ...decoded.params });
        initialStep.current = decoded.step;
        if (decoded.rejected.length) setNotice('Some link settings were ignored because they are not adjustable: ' + decoded.rejected.join(', ') + '.');
      } else if (response.type === 'error') setError('This release could not be verified, so it was not loaded. (' + response.code + ')');
    });
    return () => { alive = false; };
  }, [digest, packId, scenarioId, trust, engineMode, base]);

  const release = loaded?.release ?? null;
  const scenario = useMemo(() => release?.scenarios.find(s => s.id === scenarioId) ?? null, [release, scenarioId]);
  const edits = useMemo(() => ({ disabledRules: disabled }), [disabled]);

  // Execute whenever the framework, inputs or sandbox edits change.
  useEffect(() => {
    if (!release || !scenario || !values || !mode || !client.current) return;
    let alive = true;
    setBusy(true); setPlaying(false);
    const engine = client.current;
    const done = (summary: PreparedSummary) => { setPrepared(summary); setBusy(false); };
    if (mode === 'compare') {
      void engine.request('compute', generation => ({ type: 'compare', generation, scenarioId, params: values, edits })).then(r => {
        if (!alive || !r) return;
        if (r.type === 'compare') { done(r.prepared); if (r.comparison) { setComparison(r.comparison); setRun(null); setCompareSide(s => s ?? r.comparison!.proposal.frameworkId); } }
        else if (r.type === 'error') { setError(r.message); setBusy(false); }
      });
    } else {
      void engine.request('compute', generation => ({ type: 'run', generation, scenarioId, frameworkId: mode, params: values, edits })).then(r => {
        if (!alive || !r) return;
        if (r.type === 'run') {
          done(r.prepared);
          if (r.run) {
            setRun(r.run); setComparison(null);
            const wanted = initialStep.current;
            initialStep.current = null;
            setStep(s => Math.min(wanted ?? s, r.run!.events.length));
          }
        } else if (r.type === 'error') { setError(r.message); setBusy(false); }
      });
    }
    return () => { alive = false; };
  }, [release, scenario, values, mode, edits, scenarioId]);

  const activeRun = mode === 'compare' ? (comparison ? (compareSide === comparison.baseline.frameworkId ? comparison.baseline : comparison.proposal) : null) : run;
  const stops = useMemo(() => activeRun ? checkpointSteps(activeRun) : [], [activeRun]);
  const state = useMemo(() => release && activeRun ? playbackState(release, activeRun, step) : null, [release, activeRun, step]);

  // Playback advances one checkpoint at a time; simulated time never comes from the clock.
  useEffect(() => {
    if (!playing || !activeRun) return;
    if (step >= activeRun.events.length) { setPlaying(false); return; }
    const next = stops.find(s => s > step) ?? activeRun.events.length;
    const timer = setTimeout(() => setStep(next), 1400 / speed);
    return () => clearTimeout(timer);
  }, [playing, step, stops, activeRun, speed]);

  // Keep a shareable, pinned URL with only allowlisted settings.
  useEffect(() => {
    if (!scenario || !values || !mode || !loaded) return;
    const q = encodeShare(scenario, { packId, release: loaded.manifestDigest, scenarioId, framework: mode, step: step || null, params: values });
    const url = window.location.pathname + '?' + q;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, '', url);
  }, [scenario, values, mode, step, loaded, packId, scenarioId]);

  const select = useCallback((s: Selection) => {
    setSelection(s);
    if (s.kind === 'event' && activeRun) { const i = activeRun.events.findIndex(e => e.id === s.id); if (i >= 0) setStep(i + 1); }
  }, [activeRun]);
  // The guided tour focuses stable semantic targets and returns the visitor to their place.
  const tourSteps = scenario?.tour ?? [];
  const tourReturn = useRef<{ step: number; selection: Selection | null } | null>(null);
  useEffect(() => {
    if (tour === null || !activeRun) return;
    const t = tourSteps[tour];
    if (!t) return;
    const f = t.focus;
    if (f.kind === 'checkpoint') {
      const i = activeRun.events.findIndex(e => e.checkpoint === f.id && e.category !== 'exception');
      if (i >= 0) { setStep(i + 1); setSelection({ kind: 'event', id: activeRun.events[i]!.id }); }
    } else if (f.kind === 'actor') { setSelection({ kind: 'actor', id: f.id }); const i = activeRun.events.findIndex(e => e.actorId === f.id); if (i >= 0) setStep(i + 1); }
    else if (f.kind === 'rule') { if (mode !== 'compare' && mode !== f.frameworkId) setMode(f.frameworkId); setSelection({ kind: 'rule', frameworkId: f.frameworkId, id: f.id }); const i = activeRun.events.findIndex(e => e.ruleId === f.id); if (i >= 0) setStep(i + 1); }
    else if (f.kind === 'provision') setSelection({ kind: 'provision', versionId: f.versionId, id: f.id });
    else setSelection({ kind: 'event', id: f.id });
  }, [tour, activeRun]);
  const startTour = () => { tourReturn.current = { step, selection }; setPlaying(false); setTour(0); };
  const endTour = () => { const back = tourReturn.current; setTour(null); if (back) { setStep(back.step); setSelection(back.selection); } };

  const highlight = useMemo(() => {
    const ids = new Set<string>();
    if (selection?.kind === 'actor') ids.add(selection.id);
    if (selection?.kind === 'event' && activeRun) { const e = activeRun.events.find(x => x.id === selection.id); if (e) ids.add(e.actorId); }
    return ids;
  }, [selection, activeRun]);

  if (releaseProblem) return <div className="explorer-status" role="alert">
    <h2>{releaseProblem === 'withdrawn' ? 'This link points to a withdrawn release' : 'This link points to a release that is not available'}</h2>
    <p>{releaseProblem === 'withdrawn' ? 'The publisher withdrew this version' + (requestedEntry?.note ? ': ' + requestedEntry.note : '.') : 'The release in this link is not one of the published versions of this pack.'} The current model was not substituted automatically.</p>
    <p><a href={'/packs/' + packId + '/scenarios/' + scenarioId}>Open this scenario in the current release</a></p>
  </div>;
  if (error) return <div className="explorer-status error-notice" role="alert"><strong>Cannot continue.</strong> {error}</div>;
  if (!loaded || !release || !scenario || !values || !mode) return <p className="explorer-status status-notice" role="status"><span className="notice-mark" aria-hidden="true">…</span>Verifying the published release and starting the simulation{engineMode === 'main-thread' ? ' (in this page, because a background worker is unavailable)' : ''}.</p>;

  const framework = release.frameworks.find(f => f.id === (mode === 'compare' ? compareSide : mode)) ?? release.frameworks[0]!;
  const coverage = release.coverage.find(c => c.frameworkId === framework.id);
  const partial = coverage ? coverage.counts.ambiguous + coverage.counts.unsupported + coverage.counts['explanatory-only'] > 0 : true;
  const baseline = release.frameworks.find(f => f.role === 'baseline');
  const issues = prepared?.issues ?? [];
  const modifiedRules = Object.values(disabled).some(list => list.length > 0);
  const resetAll = () => { setValues(defaultParameterValues(scenario)); setDisabled({}); setStep(0); setSelection(null); };
  const toggleRule = (ruleId: string) => setDisabled(d => { const list = d[framework.id] ?? []; return { ...d, [framework.id]: list.includes(ruleId) ? list.filter(x => x !== ruleId) : [...list, ruleId] }; });
  const download = async () => {
    if (!activeRun) return;
    const p = prepareScenario(release, scenarioId, values, edits);
    const data = await exportRun(release, loaded.releaseId, loaded.manifestDigest, p, activeRun);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = packId + '-' + scenarioId + '-' + activeRun.frameworkId + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setNotice('Downloaded a local export. It records the pinned release and inputs; the server can recompute it on the verification page.');
  };
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setNotice('Link copied. It pins this release, scenario and your settings.'); }
    catch { setNotice('Copy this page address to share: ' + window.location.href); }
  };

  return <div className={'explorer mobile-' + mobileView} data-busy={busy}>
    <div className="explorer__labels" aria-label="Status of this model">
      {release.fictional && <span className="status-label status-label--unverified">Fictional law</span>}
      <span className="status-label status-label--draft">{framework.label} · {framework.status === 'enacted' ? 'recorded as in force' : framework.status + ' — not enacted'}</span>
      <span className="status-label status-label--hypothetical">Hypothetical scenario</span>
      {baseline && <span className="status-label status-label--neutral">Baseline dated {formatDate(baseline.asOf)}</span>}
      {partial && <span className="status-label status-label--partial">Partial coverage</span>}
      {(prepared?.modified || modifiedRules) && <span className="status-label status-label--sandbox">Your experiment — not the published scenario</span>}
      <span className={'status-label ' + (loaded.signature.valid ? 'status-label--verified' : 'status-label--neutral')} title={loaded.manifestDigest}>{loaded.signature.valid ? 'Verified & signed (' + loaded.signature.keyId + ')' : 'Integrity verified · ' + (loaded.signature.reason === 'UNSIGNED' ? 'unsigned' : 'signature not trusted')}</span>
    </div>
    {modifiedRules && <p className="sandbox-banner" role="note"><strong>Modified model.</strong> You switched off {Object.values(disabled).flat().length} rule(s). This sandbox is not the published pack and cannot be shared or exported as it.</p>}

    <div className="explorer__modes" role="radiogroup" aria-label="Legal framework">
      {release.frameworks.map(f => <label key={f.id} className={'mode' + (mode === f.id ? ' is-on' : '')}><input type="radio" name="framework" checked={mode === f.id} onChange={() => { setMode(f.id); setStep(0); setSelection(null); }} /> {f.role === 'baseline' ? 'Current law' : 'Proposal'}: {f.label}</label>)}
      {release.frameworks.length > 1 && <label className={'mode' + (mode === 'compare' ? ' is-on' : '')}><input type="radio" name="framework" checked={mode === 'compare'} onChange={() => { setMode('compare'); setStep(0); setSelection(null); }} /> Compare both</label>}
      {tourSteps.length > 0 && tour === null && <button type="button" className="lm-button lm-button--secondary" onClick={startTour}>Take the guided tour</button>}
    </div>

    {tour !== null && tourSteps[tour] && <section className="tour" aria-live="polite" aria-labelledby="tour-title">
      <p className="eyebrow">GUIDED TOUR · {tour + 1} OF {tourSteps.length}</p>
      <h2 id="tour-title">{tourSteps[tour]!.title}</h2>
      <p>{tourSteps[tour]!.body}</p>
      <div className="tour__buttons">
        <button type="button" className="lm-button lm-button--secondary" onClick={() => setTour(t => Math.max(0, (t ?? 0) - 1))} disabled={tour === 0}>Back</button>
        {tour < tourSteps.length - 1 ? <button type="button" className="lm-button lm-button--primary" onClick={() => setTour(t => (t ?? 0) + 1)}>Next</button>
          : <button type="button" className="lm-button lm-button--primary" onClick={() => { endTour(); setMode('compare'); }}>Compare the frameworks</button>}
        <button type="button" className="linklike" onClick={endTour}>Leave the tour and return to where I was</button>
      </div>
    </section>}

    {mode === 'compare' && comparison && <>
      <ComparePanel release={release} comparison={comparison} startDate={scenario.startDate} onSelectCheckpoint={(fid, key) => {
        setCompareSide(fid);
        const r = fid === comparison.baseline.frameworkId ? comparison.baseline : comparison.proposal;
        const i = r.events.findIndex(e => e.checkpoint === key);
        if (i >= 0) { setStep(i + 1); setSelection({ kind: 'event', id: r.events[i]!.id }); }
      }} />
      <div className="explorer__modes" role="radiogroup" aria-label="Framework shown below">
        {[comparison.baseline, comparison.proposal].map(r => <label key={r.frameworkId} className={'mode' + (compareSide === r.frameworkId ? ' is-on' : '')}><input type="radio" name="side" checked={compareSide === r.frameworkId} onChange={() => { setCompareSide(r.frameworkId); setStep(0); setSelection(null); }} /> Show {release.frameworks.find(f => f.id === r.frameworkId)?.label}</label>)}
      </div>
    </>}

    {activeRun && state && <>
      <div className="view-toggle" role="group" aria-label="View">
        <button type="button" aria-pressed={mobileView === 'list'} onClick={() => setMobileView('list')}>Steps</button>
        <button type="button" aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}>Map</button>
      </div>
      <p className="visually-hidden" aria-live="polite">{state.announcement}</p>
      <div className="explorer__grid">
        <div className="explorer__stage">
          <SceneMap release={release} state={state} selectedActor={selection?.kind === 'actor' ? selection.id : null} highlight={highlight} onSelectActor={id => setSelection({ kind: 'actor', id })} />
          <Timeline run={activeRun} step={step} playing={playing} speed={speed} stops={stops} onStep={setStep} onPlay={p => { if (p && step >= activeRun.events.length) setStep(0); setPlaying(p); }} onSpeed={setSpeed} />
          <p className="now-card" aria-hidden="true">{state.event ? state.announcement : 'Press Play to follow the ' + (release.domain === 'institutional-process' ? 'claim' : 'process') + ', or choose a step.'}</p>
        </div>
        <SequenceList release={release} run={activeRun} step={step} selectedEvent={selection?.kind === 'event' ? selection.id : null} highlight={new Set()} onSelect={(id, n) => { setPlaying(false); setStep(n); setSelection({ kind: 'event', id }); }} />
        <Inspector release={release} run={activeRun} digest={loaded.manifestDigest} selection={selection} onSelect={select} onClose={() => setSelection(null)} />
      </div>
      <Outcome release={release} run={activeRun} />
    </>}
    {busy && <p className="status-notice" role="status">Running the model…</p>}

    <div className="explorer__lower">
      <Controls release={release} scenario={scenario} values={values} issues={issues} disabledRules={disabled[framework.id] ?? []} frameworkId={framework.id}
        onChange={(id, v) => setValues(old => ({ ...(old ?? {}), [id]: v }))} onReset={resetAll} onToggleRule={toggleRule} />
      <section className="actions" aria-labelledby="actions-h">
        <h2 id="actions-h">Share and keep</h2>
        <button type="button" className="lm-button lm-button--secondary" onClick={share} disabled={modifiedRules}>Copy a link to this run</button>
        <button type="button" className="lm-button lm-button--secondary" onClick={download} disabled={!activeRun || modifiedRules}>Download as JSON</button>
        <button type="button" className="lm-button lm-button--secondary" onClick={() => window.print()}>Print an explanation report</button>
        <p className="muted small">Links contain only the release, scenario and the adjustable settings above — never free text. Downloads are local exports; use <a href="/verify">verification</a> to have the server recompute one.</p>
        {scenario.workload && <p><a href={'/packs/' + packId + '/stress?scenario=' + scenarioId}>Stress-test this scenario</a></p>}
        <p className="muted small">Release {loaded.releaseId} · {engineMode === 'worker' ? 'computed in a background worker' : 'computed in this page'}</p>
        <p role="status" className="small">{notice}</p>
      </section>
    </div>
  </div>;
}

function Outcome({ release, run }: { release: PackRelease; run: PackRun }) {
  const framework = release.frameworks.find(f => f.id === run.frameworkId)!;
  const names = new Map(release.actors.map(a => [a.id, a.name]));
  const unresolved = run.events.filter(e => e.outcome === 'unknown');
  return <section className="outcome" aria-labelledby="outcome-h">
    <h2 id="outcome-h">Outcome under {framework.label}</h2>
    {run.duties.length > 0 && <div className="table-wrap" tabIndex={0} role="region" aria-label="Duties table"><table>
      <caption className="visually-hidden">Duties</caption>
      <thead><tr><th scope="col">Duty</th><th scope="col">Owed by</th><th scope="col">Legal due date</th><th scope="col">Performed</th><th scope="col">Status</th></tr></thead>
      <tbody>{run.duties.map(d => <tr key={d.id}><th scope="row">{framework.rules.find(r => r.id === d.ruleId)?.effect.summary ?? d.action}</th><td>{names.get(d.actorId)}</td>
        <td>{d.deadline === 'none' ? 'None stated' : d.deadline === 'unresolved' ? 'Unresolved' : formatDate(d.dueDate)}</td><td>{d.performedDate ? formatDate(d.performedDate) : '—'}</td>
        <td className={'duty-state duty-state--' + d.state}>{DUTY_LABEL[d.state]}</td></tr>)}</tbody>
    </table></div>}
    {run.statuses.length > 0 && <><h3>Rights and permissions that arose</h3><ul>{run.statuses.map(s => <li key={s.id}>{names.get(s.holderId)} {s.force === 'permission' ? 'may' : s.force === 'right' ? 'has a right to' : 'must not'} {s.action.replace(/-/g, ' ')} (from {formatDate(run.events.find(e => e.ruleId === s.ruleId)?.date)}). This is an option, not an automatic result.</li>)}</ul></>}
    {unresolved.length > 0 && <div className="unresolved-note" role="note"><strong>Unresolved:</strong> {unresolved.length} step(s) depend on unknown facts or an unresolved reading. The model does not pick an answer.</div>}
    {run.beyondHorizon.length > 0 && <p className="muted small">Not shown: {run.beyondHorizon.length} later event(s) after the {run.horizonDay}-day horizon.</p>}
    <p className="muted small">{run.warnings.includes('HYPOTHETICAL_ENACTMENT_NOT_CURRENT_LAW') ? 'The proposal is run as if it had been enacted. It is not current law. ' : ''}No real filing, receipt, deadline or legal advice is produced.</p>
  </section>;
}
