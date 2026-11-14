'use client';
import type { PackRelease } from '../../../../../packages/contracts/src/index.ts';
import type { PackRun } from '../../../../../packages/simulation/src/pack-engine.ts';
import { sequenceView } from '../../../../../packages/presentation/src/index.ts';
import { BASIS_LABEL, CATEGORY_LABEL, formatDate } from './labels.ts';

/** The accessible sequence view is a projection of the same trace as the map. */
export function SequenceList({ release, run, step, selectedEvent, highlight, onSelect, heading = 'Step by step' }: {
  release: PackRelease; run: PackRun; step: number; selectedEvent: string | null; highlight: ReadonlySet<string>; onSelect: (eventId: string, step: number) => void; heading?: string;
}) {
  const days = sequenceView(release, run);
  return <section className="sequence" aria-label={heading}>
    <h2 className="sequence__title">{heading}</h2>
    <ol className="sequence__days">
      {days.map(day => <li key={day.date} className="sequence__day">
        <h3>{formatDate(day.date)} <span className="sequence__dayn">day {day.day}</span></h3>
        <ol>
          {day.items.map(({ step: n, event, actorName }) => {
            const future = n > step;
            return <li key={event.id} className={'sequence__item cat--' + event.category + (future ? ' is-future' : '') + (n === step ? ' is-current' : '') + (highlight.has(event.id) ? ' is-highlighted' : '')} aria-current={n === step ? 'step' : undefined}>
              <button type="button" onClick={() => onSelect(event.id, n)} aria-pressed={selectedEvent === event.id}>
                <span className={'badge badge--' + event.category}>{CATEGORY_LABEL[event.category]}</span>
                <span className="sequence__label">{event.label}</span>
                <span className="sequence__meta">{actorName} · {BASIS_LABEL[event.basis]}{event.dueDate ? ' · due ' + formatDate(event.dueDate) : ''}{event.outcome === 'breached' ? ' · breached' : ''}{event.outcome === 'unknown' ? ' · unresolved' : ''}</span>
              </button>
            </li>;
          })}
        </ol>
      </li>)}
    </ol>
  </section>;
}
