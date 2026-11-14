'use client';
import type { PackRun } from '../../../../../packages/simulation/src/pack-engine.ts';
import { formatDate } from './labels.ts';

export function Timeline({ run, step, playing, speed, stops, onStep, onPlay, onSpeed }: {
  run: PackRun; step: number; playing: boolean; speed: number; stops: readonly number[];
  onStep: (step: number) => void; onPlay: (playing: boolean) => void; onSpeed: (speed: number) => void;
}) {
  const total = run.events.length;
  const current = step > 0 ? run.events[step - 1] : null;
  const next = stops.find(s => s > step) ?? total;
  const previous = [...stops].reverse().find(s => s < step) ?? 0;
  return <section className="timeline" aria-label="Playback">
    <div className="timeline__buttons">
      <button type="button" className="lm-button lm-button--secondary" onClick={() => { onPlay(false); onStep(0); }}>Reset</button>
      <button type="button" className="lm-button lm-button--secondary" onClick={() => { onPlay(false); onStep(previous); }} disabled={step === 0}>◀ Back</button>
      <button type="button" className="lm-button lm-button--primary" onClick={() => onPlay(!playing)} aria-pressed={playing}>{playing ? 'Pause' : step >= total ? 'Replay' : 'Play'}</button>
      <button type="button" className="lm-button lm-button--secondary" onClick={() => { onPlay(false); onStep(next); }} disabled={step >= total}>Next ▶</button>
      <button type="button" className="lm-button lm-button--secondary" onClick={() => { onPlay(false); onStep(total); }} disabled={step >= total}>Jump to outcome</button>
      <label className="timeline__speed">Speed <select value={speed} onChange={e => onSpeed(Number(e.target.value))}>
        <option value={0.5}>Slow</option><option value={1}>Normal</option><option value={2}>Fast</option></select></label>
    </div>
    <label className="timeline__scrub">
      <span className="visually-hidden">Scenario step</span>
      <input type="range" min={0} max={total} step={1} value={step} onChange={e => { onPlay(false); onStep(Number(e.target.value)); }}
        aria-valuetext={current ? 'Step ' + step + ' of ' + total + ': ' + formatDate(current.date) + ', ' + current.label : 'Before the scenario starts'} />
    </label>
    <ol className="timeline__marks" aria-hidden="true">
      {run.events.map((e, i) => <li key={e.id} style={{ left: (total ? ((i + 1) / total) * 100 : 0) + '%' }} className={'mark mark--' + e.category + (i + 1 <= step ? ' is-past' : '')} title={e.label} />)}
    </ol>
    <p className="timeline__now">{current ? <><strong>{formatDate(current.date)}</strong> · step {step} of {total}</> : <>Start · {total} steps</>}</p>
  </section>;
}
