'use client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { search, type SearchDoc } from '../../../../packages/presentation/src/index.ts';

const KIND: Record<SearchDoc['kind'], string> = { glossary: 'Term', provision: 'Source text', scenario: 'Scenario', rule: 'Rule' };
export function SearchBox({ docs, packs }: { docs: readonly SearchDoc[]; packs: readonly { id: string; title: string }[] }) {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [pack, setPack] = useState(packs.some(p => p.id === params.get('pack')) ? params.get('pack')! : '');
  const hits = useMemo(() => search(pack ? docs.filter(d => d.packId === pack) : docs, q, 30), [docs, q, pack]);
  return <div>
    <form role="search" onSubmit={e => e.preventDefault()} className="search__form">
      <label htmlFor="q" className="control__label">Search for</label>
      <input id="q" type="search" value={q} onChange={e => setQ(e.target.value.slice(0, 200))} placeholder="e.g. wrong agency, deadline, fee" autoComplete="off" />
      <label htmlFor="pack" className="control__label">In</label>
      <select id="pack" value={pack} onChange={e => setPack(e.target.value)}><option value="">All models</option>{packs.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
    </form>
    <p role="status" className="muted">{q.trim() ? hits.length + ' result' + (hits.length === 1 ? '' : 's') : ''}</p>
    <ol className="search__results">{hits.map(h => <li key={h.id}>
      <p className="search__kind"><span className="badge">{KIND[h.kind]}</span> {h.status}{h.source ? ' · ' + h.source : ''}</p>
      <h2><a href={h.href}>{h.title}</a></h2>
      <p>{h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text}</p>
    </li>)}</ol>
  </div>;
}
