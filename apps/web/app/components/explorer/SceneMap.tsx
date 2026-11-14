'use client';
import type { KeyboardEvent } from 'react';
import type { PackRelease } from '../../../../../packages/contracts/src/index.ts';
import type { PlaybackState } from '../../../../../packages/presentation/src/index.ts';

const GLYPH: Record<string, string> = {
  person: 'M0-9a5 5 0 1 0 .1 0M-9 9c1-6 4-8 9-8s8 2 9 8z',
  agency: 'M-10 9h20M-8 9v-9M-3 9v-9M3 9v-9M8 9v-9M-11 0h22L0-9z',
  office: 'M-9-8h18v17h-18zM-5-4h4v4h-4zM1-4h4v4h-4zM-2 4h4v5h-4z',
  court: 'M-10 9h20M-7 7v-8M7 7v-8M0 7v-8M-11-2h22L0-10z',
  portal: 'M-10-7h20v12h-20zM-3 9h6M0 5v4',
  ledger: 'M-8-9h16v18h-16zM-5-4h10M-5 0h10M-5 4h6',
  oversight: 'M-10 0q10-12 20 0q-10 12-20 0M0-3a3 3 0 1 0 .1 0'
};
function nameLines(name: string): string[] {
  if (name.length <= 15) return [name];
  const words = name.split(' ');
  let first = '';
  while (words.length && (first + ' ' + words[0]).trim().length <= 15) first = (first + ' ' + words.shift()).trim();
  const rest = words.join(' ');
  return [first || name.slice(0, 15), rest.length > 17 ? rest.slice(0, 16) + '…' : rest].filter(Boolean);
}
/** Positions are presentation only; selecting or moving a node never changes the trace. */
export function SceneMap({ release, state, selectedActor, highlight, onSelectActor }: {
  release: PackRelease; state: PlaybackState; selectedActor: string | null; highlight: ReadonlySet<string>; onSelectActor: (id: string) => void;
}) {
  const scene = release.scene;
  const nodes = new Map(state.nodes.map(n => [n.actorId, n]));
  const order = state.nodes.map(n => n.actorId);
  const holder = state.objectAt ? nodes.get(state.objectAt) : null;
  const onKey = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectActor(id); return; }
    const i = order.indexOf(id);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? order[(i + 1) % order.length] : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? order[(i - 1 + order.length) % order.length] : null;
    if (next) { event.preventDefault(); (document.querySelector('[data-actor="' + next + '"]') as SVGGElement | null)?.focus(); }
  };
  return <figure className="scene-map" aria-labelledby="scene-title">
    <figcaption id="scene-title" className="visually-hidden">{scene.title}. Use Tab or arrow keys to move between institutions and Enter to inspect one.</figcaption>
    <svg viewBox={'0 0 ' + scene.width + ' ' + scene.height} role="group" aria-label={scene.title}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="arrow-head" /></marker>
      </defs>
      {state.edges.map(e => {
        const a = nodes.get(e.from), b = nodes.get(e.to);
        if (!a || !b) return null;
        // Parallel edges between the same pair fan out so labels and paths never overlap.
        const pair = [e.from, e.to].sort().join('|');
        const siblings = state.edges.filter(x => [x.from, x.to].sort().join('|') === pair);
        const k = siblings.indexOf(e) - (siblings.length - 1) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const sign = e.from < e.to ? 1 : -1;
        const bend = (siblings.length > 1 ? k * 46 : 16) * sign;
        const mx = (a.x + b.x) / 2 - (dy / len) * bend, my = (a.y + b.y) / 2 + (dx / len) * bend;
        const lx = (a.x + 2 * mx + b.x) / 4, ly = (a.y + 2 * my + b.y) / 4;
        const show = e.active || e.travelled;
        return <g key={e.id} className={'scene-edge scene-edge--' + e.kind + (e.active ? ' is-active' : '') + (e.travelled ? ' is-travelled' : '')} aria-hidden="true">
          <title>{e.label}</title>
          <path d={'M' + a.x + ' ' + a.y + ' Q' + mx + ' ' + my + ' ' + b.x + ' ' + b.y} markerEnd="url(#arrow)" />
          {show && <text x={lx} y={ly - 5} textAnchor="middle" className="scene-edge__label">{e.label}</text>}
        </g>;
      })}
      {state.nodes.map(n => {
        const classes = ['scene-node', n.active ? 'is-active' : '', selectedActor === n.actorId ? 'is-selected' : '', highlight.has(n.actorId) ? 'is-highlighted' : '', n.breachedDuties ? 'has-breach' : ''].join(' ');
        const status = [n.pendingDuties ? n.pendingDuties + ' pending ' + (n.pendingDuties > 1 ? 'duties' : 'duty') : '', n.breachedDuties ? n.breachedDuties + ' breached' : '', n.holdsObject ? 'holds the claim now' : ''].filter(Boolean).join(', ');
        const meta = n.breachedDuties ? '⚠ breached' : n.pendingDuties ? '◷ duty pending' : n.satisfiedDuties ? '✓ duty met' : release.actors.find(a => a.id === n.actorId)?.kind ?? '';
        return <g key={n.actorId} className={classes} transform={'translate(' + n.x + ' ' + n.y + ')'} tabIndex={0} role="button" data-actor={n.actorId}
          aria-describedby={'node-desc-' + n.actorId} aria-pressed={selectedActor === n.actorId} onClick={() => onSelectActor(n.actorId)} onKeyDown={e => onKey(e, n.actorId)}>
          <desc id={'node-desc-' + n.actorId}>{status || 'No pending duties'}</desc>
          <rect x={-72} y={-32} width={144} height={64} rx={10} />
          <g transform="translate(-50 0)" className="scene-glyph"><path d={GLYPH[n.icon] ?? GLYPH.office} /></g>
          <text x={-32} y={nameLines(n.name).length > 1 ? -12 : -4} className="scene-node__name">{nameLines(n.name).map((line, i) => <tspan key={i} x={-32} dy={i ? 14 : 0}>{(i ? ' ' : '') + line}</tspan>)}</text>
          <text x={-32} y={nameLines(n.name).length > 1 ? 20 : 14} className="scene-node__meta">{' ' + meta}</text>
        </g>;
      })}
      {holder && <g className="scene-token" style={{ transform: 'translate(' + (holder.x + 60) + 'px,' + (holder.y - 36) + 'px)' }} aria-hidden="true">
        <path d="M-9-12h13l5 5v19h-18z" /><path d="M-5-4h9M-5 1h9M-5 6h6" className="scene-token__lines" />
      </g>}
    </svg>
    <p className="scene-legend"><span className="legend-route">→ route</span> <span className="legend-authority">⇢ authority</span> <span>📄 where the item is</span></p>
  </figure>;
}
