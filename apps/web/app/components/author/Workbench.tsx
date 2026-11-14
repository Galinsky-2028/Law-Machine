'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuthoredPack, AuthoredRef, Condition, PackRelease, PackRule, ScenarioSpec } from '../../../../../packages/contracts/src/pack.ts';
import { provisionPaths } from '../../../../../packages/legislation/src/pack-builder.ts';
import { runPackScenario, type PackRun } from '../../../../../packages/simulation/src/pack-engine.ts';
import { api, ApiError, explain } from '../../lib/author-client.ts';
import { withReauth } from './OrgDashboard.tsx';

type Row = Record<string, unknown>;
type PackData = { documentId: string; packId: string; revision: number; payload: AuthoredPack; sources: Row[]; jobs: Row[]; validations: Row[]; releases: Row[]; pointer: Row | null; history: Row[] };
type Provision = { path: string; citation: string; text: string };
type Tab = 'overview' | 'sources' | 'model' | 'rules' | 'scenarios' | 'json' | 'publish' | 'suggestions' | 'history';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['sources', 'Sources'], ['model', 'Actors & facts'], ['rules', 'Rules'], ['scenarios', 'Scenarios'], ['json', 'JSON'], ['publish', 'Validate & publish'], ['suggestions', 'Suggestions'], ['history', 'History']];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fact = (key: string): Condition => ({ op: 'truth', value: { op: 'fact-value', key } });

async function pollJob(org: string, jobId: string, onTick: (s: string) => void): Promise<Row> {
  for (let i = 0; i < 120; i++) {
    const job = await api<Row>('/api/v1/author/' + org + '/jobs/' + jobId);
    onTick(String(job.state));
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') return job;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new ApiError(504, 'JOB_TIMEOUT');
}

export function Workbench({ org, doc }: { org: string; doc: string }) {
  const base = '/api/v1/author/' + org;
  const [data, setData] = useState<PackData | null>(null);
  const [payload, setPayload] = useState<AuthoredPack | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [message, setMessage] = useState('');
  const [provisions, setProvisions] = useState<Record<string, Provision[]>>({});
  const [prefill, setPrefill] = useState<Partial<RuleDraft> | null>(null);
  const load = useCallback(async (keepLocal = false) => {
    try {
      const d = await api<PackData>(base + '/packs/' + doc);
      setData(d);
      if (!keepLocal) { setPayload(d.payload); setDirty(false); }
    } catch (e) { setMessage(explain(e)); }
  }, [base, doc]);
  useEffect(() => { void load(); }, [load]);
  // Load parsed provisions for every stored source so rules can cite exact text.
  useEffect(() => {
    if (!data) return;
    for (const s of data.sources) {
      const id = String(s.id);
      if (!s.parsed || provisions[id]) continue;
      void api<{ normalized: { provisions: { id: string; parentId: string | null; citation: string | null; text: string; span: { start: number } }[] } }>(base + '/sources/' + id).then(src => {
        const paths = provisionPaths(src.normalized.provisions);
        setProvisions(p => ({ ...p, [id]: src.normalized.provisions.map(x => ({ path: paths.get(x.id)!.path, citation: paths.get(x.id)!.citation, text: x.text })) }));
      }).catch(() => undefined);
    }
  }, [data, base, provisions]);
  const update = (fn: (p: AuthoredPack) => void) => setPayload(prev => { if (!prev) return prev; const next = clone(prev); fn(next); setDirty(true); return next; });
  const save = async (): Promise<boolean> => {
    if (!payload || !data) return false;
    setMessage('Saving…');
    try { const r = await api<{ revision: number }>(base + '/packs/' + doc, { method: 'PUT', body: { expectedRevision: data.revision, payload } }); setMessage('Saved revision ' + r.revision + '.'); await load(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_REVISION') { setMessage('Someone saved a newer revision. Your edits are kept here; copy them from the JSON tab, then reload.'); await load(true); }
      else setMessage(explain(e));
      return false;
    }
  };
  if (!data || !payload) return <p role="status">{message || 'Loading the model…'}</p>;
  const sourceProvisions = (sourceId: string): Provision[] => { const s = payload.sources.find(x => x.id === sourceId); return s?.objectId ? provisions[s.objectId] ?? [] : []; };
  return <div className="workbench">
    <div className="workbench__head">
      <div><p className="eyebrow">{payload.fictional ? 'FICTIONAL MODEL' : 'SOURCED MODEL'} · <code>{data.packId}</code></p><h1>{payload.title}</h1>
        <p className="muted">Revision {data.revision}{dirty ? ' · unsaved changes' : ''}</p></div>
      <div className="workbench__save"><button type="button" className="lm-button lm-button--primary" disabled={!dirty} onClick={() => void save()}>Save revision</button>
        <button type="button" className="lm-button lm-button--secondary" onClick={() => void load()}>Reload</button></div>
    </div>
    <p role="status" className="author-status">{message}</p>
    <div className="tab-strip" role="tablist" aria-label="Workbench sections">
      {TABS.map(([id, label]) => <button key={id} role="tab" type="button" id={'wb-' + id} aria-selected={tab === id} aria-controls={'wbp-' + id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div role="tabpanel" id={'wbp-' + tab} aria-labelledby={'wb-' + tab} className="workbench__panel">
      {tab === 'overview' && <Overview payload={payload} update={update} />}
      {tab === 'sources' && <Sources org={org} doc={doc} data={data} payload={payload} update={update} provisions={provisions} setMessage={setMessage} reload={() => load(true)} />}
      {tab === 'model' && <ModelEditor payload={payload} update={update} />}
      {tab === 'rules' && <Rules payload={payload} update={update} sourceProvisions={sourceProvisions} prefill={prefill} clearPrefill={() => setPrefill(null)} />}
      {tab === 'scenarios' && <Scenarios payload={payload} update={update} />}
      {tab === 'json' && <JsonEditor payload={payload} onApply={p => { setPayload(p); setDirty(true); setMessage('Applied. Save to keep it.'); }} />}
      {tab === 'publish' && <Publish org={org} doc={doc} data={data} dirty={dirty} save={save} setMessage={setMessage} reload={() => load(true)} />}
      {tab === 'suggestions' && <Suggestions org={org} doc={doc} onUse={c => { setPrefill(c); setTab('rules'); }} setMessage={setMessage} />}
      {tab === 'history' && <ul className="history">{data.history.map((h, i) => <li key={i}>{String(h.at).slice(0, 19).replace('T', ' ')} · revision {String(h.revision)} · {String(h.action)} by {String(h.actor)}</li>)}</ul>}
    </div>
  </div>;
}

function Field({ id, label, value, onChange, help, multiline = false, type = 'text' }: { id: string; label: string; value: string; onChange: (v: string) => void; help?: string; multiline?: boolean; type?: string }) {
  return <div className="control"><label className="control__label" htmlFor={id}>{label}</label>
    {multiline ? <textarea id={id} value={value} rows={3} onChange={e => onChange(e.target.value)} /> : <input id={id} type={type} value={value} onChange={e => onChange(e.target.value)} />}
    {help && <p className="control__help">{help}</p>}</div>;
}

function Overview({ payload, update }: { payload: AuthoredPack; update: (fn: (p: AuthoredPack) => void) => void }) {
  type W = { -readonly [K in keyof AuthoredPack]: AuthoredPack[K] };
  const set = (key: 'title' | 'question' | 'summary' | 'domain' | 'releaseLabel' | 'releasedAt') => (v: string) => update(p => { (p as W)[key] = v; });
  return <div className="form-grid">
    <Field id="ov-title" label="Title" value={payload.title} onChange={set('title')} />
    <Field id="ov-q" label="Question this model answers" value={payload.question} onChange={set('question')} />
    <Field id="ov-s" label="Summary" value={payload.summary} onChange={set('summary')} multiline />
    <Field id="ov-d" label="Domain" value={payload.domain} onChange={set('domain')} help="For example institutional-process, permits, resource-allocation." />
    <div className="control"><label><input type="checkbox" checked={payload.fictional} onChange={e => update(p => { (p as W).fictional = e.target.checked; })} /> This model uses invented (fictional) law</label>
      <p className="control__help">Sourced models must record retrieval details for every source, and current-law sources must cite dated official material.</p></div>
    <Field id="ov-disc" label="Disclaimers (one per line)" value={payload.disclaimers.join('\n')} onChange={v => update(p => { (p as W).disclaimers = v.split('\n').map(x => x.trim()).filter(Boolean); })} multiline />
    <Field id="ov-rl" label="Release label" value={payload.releaseLabel} onChange={set('releaseLabel')} help="Change it for every release you publish, e.g. 1.0.1." />
    <Field id="ov-rd" label="Release date" type="date" value={payload.releasedAt} onChange={set('releasedAt')} />
  </div>;
}

function Sources({ org, doc, data, payload, update, provisions, setMessage, reload }: { org: string; doc: string; data: PackData; payload: AuthoredPack; update: (fn: (p: AuthoredPack) => void) => void; provisions: Record<string, Provision[]>; setMessage: (m: string) => void; reload: () => Promise<void> }) {
  const base = '/api/v1/author/' + org;
  const [file, setFile] = useState<File | null>(null);
  const [officialUrl, setOfficialUrl] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [meta, setMeta] = useState({ id: '', kind: 'fictional', title: '', origin: '', retrievedAt: '', rights: '' });
  const upload = async () => {
    if (!file) return;
    const form = new FormData();
    form.set('documentId', doc); form.set('file', file);
    if (officialUrl) form.set('officialUrl', officialUrl);
    try {
      setMessage('Uploading to private storage…');
      const r = await api<{ jobId: string; duplicate: boolean }>(base + '/imports', { form });
      const job = await pollJob(org, r.jobId, s => setMessage('Import job ' + s + '…'));
      setMessage(job.state === 'completed' ? 'Imported: ' + String((job.result as Row)?.provisionCount ?? '?') + ' provisions.' : 'Import failed: ' + String(job.last_error_code));
      await reload();
    } catch (e) { setMessage(explain(e)); }
  };
  const runJob = async (path: string, body: unknown, label: string) => {
    try { const r = await api<{ jobId: string }>(base + path, { body }); const job = await pollJob(org, r.jobId, s => setMessage(label + ' ' + s + '…')); setMessage(label + ': ' + (job.state === 'completed' ? JSON.stringify(job.result).slice(0, 300) : 'failed (' + String(job.last_error_code) + ')')); await reload(); }
    catch (e) { setMessage(explain(e)); }
  };
  return <>
    <section className="author-card" aria-labelledby="up-h"><h2 id="up-h">Add a source</h2>
      <p className="muted">Upload the exact text of a bill, regulation or invented demonstration law (.md or .txt, under 2 MB). It is encrypted in private storage and parsed by a background job; it becomes public only if a published release uses it.</p>
      <div className="control"><label className="control__label" htmlFor="src-file">File</label><input id="src-file" type="file" accept=".md,.txt,text/plain,text/markdown" onChange={e => setFile(e.target.files?.[0] ?? null)} /></div>
      <Field id="src-url" label="Official URL (optional, enables refresh checks)" value={officialUrl} onChange={setOfficialUrl} help="Only official hosts such as www.govinfo.gov or www.ecfr.gov can be refreshed." />
      <button type="button" className="lm-button lm-button--primary" disabled={!file} onClick={() => void upload()}>Upload and parse</button>
    </section>
    <section className="author-card" aria-labelledby="src-h"><h2 id="src-h">Stored sources</h2>
      {data.sources.length === 0 ? <p>None yet.</p> : <ul className="source-list">{data.sources.map(s => {
        const id = String(s.id);
        const used = payload.sources.find(x => x.objectId === id);
        return <li key={id}><strong>{String(s.name)}</strong> · {String(s.quarantine_state)} · {Number(s.bytes_count).toLocaleString()} bytes · <code>{String(s.byte_digest).slice(0, 12)}</code>{s.supersedes ? ' · newer version of an earlier source' : ''}
          {used ? <> · used as <code>{used.id}</code></> : null}
          <div className="source-actions">
            {!!provisions[id] && <button type="button" className="linklike" onClick={() => setOpen(open === id ? null : id)}>{open === id ? 'Hide' : 'Show'} {provisions[id]!.length} provisions</button>}
            {!used && !!s.parsed && <button type="button" className="linklike" onClick={() => { setOpen(id); setMeta(m => ({ ...m, id: String(s.name).replace(/\.[a-z]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), title: String(s.name) })); }}>Use in this model</button>}
            {!!s.official_url && <button type="button" className="linklike" onClick={() => void runJob('/sources/' + id + '/refresh', { documentId: doc }, 'Refresh')}>Check official source for changes</button>}
            {!!s.parsed && <button type="button" className="linklike" onClick={() => void runJob('/packs/' + doc + '/ai', { sourceId: id }, 'Suggestions')}>Suggest rules</button>}
          </div>
          {open === id && !used && !!s.parsed && <form className="inline-form" onSubmit={e => { e.preventDefault(); if (!ID.test(meta.id)) { setMessage('Source ID must be letters, numbers or dashes.'); return; }
            update(p => { (p.sources as unknown[]).push({ id: meta.id, title: meta.title, kind: meta.kind, file: 'sources/' + String(s.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'), format: s.format === 'markdown' ? 'markdown' : 'text', origin: meta.origin || 'Uploaded by an author', retrievedAt: meta.retrievedAt || null, rights: meta.rights || 'Rights not stated', ...(s.official_url ? { officialUrl: String(s.official_url) } : {}), objectId: id }); });
            setMessage('Source added to the model. Save to keep it.'); }}>
            <Field id="m-id" label="Source ID in the model" value={meta.id} onChange={v => setMeta(m => ({ ...m, id: v }))} />
            <Field id="m-title" label="Title" value={meta.title} onChange={v => setMeta(m => ({ ...m, title: v }))} />
            <div className="control"><label className="control__label" htmlFor="m-kind">Kind</label><select id="m-kind" value={meta.kind} onChange={e => setMeta(m => ({ ...m, kind: e.target.value }))}><option value="fictional">Fictional text</option><option value="bill">Bill or proposal</option><option value="baseline">Current-law baseline</option></select></div>
            <Field id="m-origin" label="Where it came from" value={meta.origin} onChange={v => setMeta(m => ({ ...m, origin: v }))} />
            <Field id="m-ret" label="Retrieved at (date or time, for real sources)" value={meta.retrievedAt} onChange={v => setMeta(m => ({ ...m, retrievedAt: v }))} />
            <Field id="m-rights" label="Rights" value={meta.rights} onChange={v => setMeta(m => ({ ...m, rights: v }))} />
            <button type="submit" className="lm-button lm-button--secondary">Add to model</button>
          </form>}
          {open === id && provisions[id] && <ol className="provision-picker">{provisions[id]!.map(p => <li key={p.path}><strong>{p.citation}</strong> <code>{p.path}</code><p className="provision-text">{p.text}</p></li>)}</ol>}
        </li>;
      })}</ul>}
    </section>
  </>;
}

function ModelEditor({ payload, update }: { payload: AuthoredPack; update: (fn: (p: AuthoredPack) => void) => void }) {
  const [actor, setActor] = useState({ id: '', name: '', kind: 'agency', description: '' });
  const [factDraft, setFact] = useState({ id: '', type: 'boolean', label: '', description: '' });
  const [fw, setFw] = useState({ id: 'proposal', label: '', role: 'proposal', status: 'draft', billId: '', version: '1', versionId: '', jurisdiction: '', agency: '', asOf: '', sourceId: '' });
  const push = (key: 'actors' | 'facts' | 'frameworks', value: unknown) => update(p => { (p[key] as unknown[]).push(value); });
  const remove = (key: 'actors' | 'facts' | 'frameworks', id: string) => update(p => { const list = p[key] as unknown as { id: string }[]; list.splice(list.findIndex(x => x.id === id), 1); });
  return <div className="three-col">
    <section className="author-card" aria-labelledby="act-h"><h2 id="act-h">Actors</h2>
      <ul>{payload.actors.map(a => <li key={a.id}>{a.name} <code>{a.id}</code> <button type="button" className="linklike" onClick={() => remove('actors', a.id)}>Remove</button></li>)}</ul>
      <form onSubmit={e => { e.preventDefault(); if (!ID.test(actor.id) || !actor.name) return; push('actors', { ...actor }); setActor({ id: '', name: '', kind: 'agency', description: '' }); }}>
        <Field id="a-id" label="ID" value={actor.id} onChange={v => setActor(a => ({ ...a, id: v }))} /><Field id="a-name" label="Name" value={actor.name} onChange={v => setActor(a => ({ ...a, name: v }))} />
        <div className="control"><label className="control__label" htmlFor="a-kind">Kind</label><select id="a-kind" value={actor.kind} onChange={e => setActor(a => ({ ...a, kind: e.target.value }))}>{['agency', 'court', 'person', 'organization', 'other'].map(k => <option key={k}>{k}</option>)}</select></div>
        <Field id="a-desc" label="Description" value={actor.description} onChange={v => setActor(a => ({ ...a, description: v }))} />
        <button type="submit" className="lm-button lm-button--secondary">Add actor</button></form>
    </section>
    <section className="author-card" aria-labelledby="fact-h"><h2 id="fact-h">Facts</h2>
      <ul>{payload.facts.map(f => <li key={f.id}>{f.label} <code>{f.id}</code> ({f.type}) <button type="button" className="linklike" onClick={() => remove('facts', f.id)}>Remove</button></li>)}</ul>
      <form onSubmit={e => { e.preventDefault(); if (!ID.test(factDraft.id) || !factDraft.label) return; push('facts', { ...factDraft, description: factDraft.description || factDraft.label }); setFact({ id: '', type: 'boolean', label: '', description: '' }); }}>
        <Field id="f-id" label="ID" value={factDraft.id} onChange={v => setFact(a => ({ ...a, id: v }))} /><Field id="f-label" label="Label" value={factDraft.label} onChange={v => setFact(a => ({ ...a, label: v }))} />
        <div className="control"><label className="control__label" htmlFor="f-type">Type</label><select id="f-type" value={factDraft.type} onChange={e => setFact(a => ({ ...a, type: e.target.value }))}><option>boolean</option><option>number</option><option>string</option></select></div>
        <button type="submit" className="lm-button lm-button--secondary">Add fact</button></form>
    </section>
    <section className="author-card" aria-labelledby="fw-h"><h2 id="fw-h">Legal frameworks</h2>
      <ul>{payload.frameworks.map(f => <li key={f.id}>{f.label} <code>{f.id}</code> · {f.role} · {f.status} · source <code>{f.sourceId}</code> · {f.rules.length} rules <button type="button" className="linklike" onClick={() => remove('frameworks', f.id)}>Remove</button></li>)}</ul>
      <form onSubmit={e => { e.preventDefault(); if (!ID.test(fw.id) || !fw.sourceId) return; push('frameworks', { ...fw, versionId: fw.versionId || fw.id + '-' + fw.version, billId: fw.billId || fw.id, rules: [], coverage: [], gaps: [] }); }}>
        <Field id="fw-id" label="ID" value={fw.id} onChange={v => setFw(a => ({ ...a, id: v }))} /><Field id="fw-label" label="Label" value={fw.label} onChange={v => setFw(a => ({ ...a, label: v }))} />
        <div className="control"><label className="control__label" htmlFor="fw-role">Role</label><select id="fw-role" value={fw.role} onChange={e => setFw(a => ({ ...a, role: e.target.value, status: e.target.value === 'baseline' ? 'enacted' : 'draft' }))}><option value="proposal">Proposal</option><option value="baseline">Current-law baseline</option></select></div>
        <div className="control"><label className="control__label" htmlFor="fw-src">Source</label><select id="fw-src" value={fw.sourceId} onChange={e => setFw(a => ({ ...a, sourceId: e.target.value }))}><option value="">Choose…</option>{payload.sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></div>
        <Field id="fw-j" label="Jurisdiction ID" value={fw.jurisdiction} onChange={v => setFw(a => ({ ...a, jurisdiction: v }))} /><Field id="fw-ag" label="Agency scope ID" value={fw.agency} onChange={v => setFw(a => ({ ...a, agency: v }))} />
        <Field id="fw-asof" label="Dated as of" type="date" value={fw.asOf} onChange={v => setFw(a => ({ ...a, asOf: v }))} />
        <button type="submit" className="lm-button lm-button--secondary">Add framework</button></form>
    </section>
  </div>;
}

type RuleDraft = { frameworkId: string; id: string; modal: PackRule<AuthoredRef>['modal']; trigger: string; actorId: string; operation: PackRule<AuthoredRef>['operation'];
  conditions: { fact: string; value: 'true' | 'false' }[]; exceptionFact: string; exceptionLabel: string; provision: string; quote: string; summary: string; plain: string; detail: string;
  checkpoint: string; deadlineAmount: string; deadlineUnit: 'business-day' | 'calendar-day' | 'calendar-month'; action: string; onPerform: string; onBreach: string; emits: string; routeTo: string; effectiveAfter: string };
const emptyRule = (frameworkId: string): RuleDraft => ({ frameworkId, id: '', modal: 'obligation', trigger: '', actorId: '', operation: 'create-obligation', conditions: [], exceptionFact: '', exceptionLabel: '', provision: '', quote: '', summary: '', plain: '', detail: '',
  checkpoint: '', deadlineAmount: '', deadlineUnit: 'business-day', action: '', onPerform: '', onBreach: '', emits: '', routeTo: '', effectiveAfter: '' });

function Rules({ payload, update, sourceProvisions, prefill, clearPrefill }: { payload: AuthoredPack; update: (fn: (p: AuthoredPack) => void) => void; sourceProvisions: (id: string) => Provision[]; prefill: Partial<RuleDraft> | null; clearPrefill: () => void }) {
  const [d, setD] = useState<RuleDraft>(() => emptyRule(payload.frameworks[0]?.id ?? ''));
  const [error, setError] = useState('');
  useEffect(() => { if (prefill) { setD(x => ({ ...x, ...prefill })); clearPrefill(); } }, [prefill, clearPrefill]);
  const framework = payload.frameworks.find(f => f.id === d.frameworkId);
  const provs = framework ? sourceProvisions(framework.sourceId) : [];
  const chosen = provs.find(p => p.path === d.provision);
  const quoteOk = !!chosen && d.quote.trim().length > 0 && chosen.text.includes(d.quote);
  const set = <K extends keyof RuleDraft>(k: K) => (v: RuleDraft[K]) => setD(x => ({ ...x, [k]: v }));
  const add = () => {
    if (!framework) return setError('Add a framework first.');
    if (!ID.test(d.id) || framework.rules.some(r => r.id === d.id)) return setError('Rule ID must be unique and use letters, numbers, dots or dashes.');
    if (!ID.test(d.trigger) || !d.actorId) return setError('Choose the event that triggers the rule and the actor it applies to.');
    if (!quoteOk) return setError('The quote must be copied exactly from the chosen provision.');
    if (!d.summary.trim() || !d.plain.trim() || !d.detail.trim()) return setError('Write a summary and both explanation texts.');
    const ref = { provision: d.provision, quote: d.quote };
    const when: Condition = d.conditions.length === 0 ? { op: 'truth', value: { op: 'literal', value: true } } : d.conditions.length === 1 ? (d.conditions[0]!.value === 'true' ? fact(d.conditions[0]!.fact) : { op: 'not', arg: fact(d.conditions[0]!.fact) })
      : { op: 'and', terms: d.conditions.map(c => c.value === 'true' ? fact(c.fact) : { op: 'not', arg: fact(c.fact) } as Condition) };
    const deadlineId = d.deadlineAmount ? d.id + '-deadline' : null;
    const common = { summary: d.summary.trim(), ...(d.checkpoint ? { checkpoint: d.checkpoint } : {}), ...(d.effectiveAfter ? { effectiveAfterEnactmentDays: Number(d.effectiveAfter) } : {}),
      ...(d.exceptionFact ? { exceptions: [{ id: d.id + '-exception', label: d.exceptionLabel || 'Exception applies', sourceRefs: [ref] }] } : {}) };
    const effect = d.operation === 'create-obligation' ? { kind: 'create-obligation', action: d.action || d.id, deadlineId, onPerformEmits: d.onPerform || d.id + '-done', ...(d.onBreach ? { onBreachEmits: d.onBreach } : {}), ...common }
      : d.operation === 'schedule' ? { kind: 'schedule', emits: d.emits || d.id + '-ended', deadlineId: deadlineId ?? '', ...common }
      : d.operation === 'route' ? { kind: 'route', to: d.routeTo, emits: d.emits || d.id + '-arrived', ...common }
      : { kind: 'record', ...(d.emits ? { emits: d.emits } : {}), ...common };
    if (d.operation === 'schedule' && !deadlineId) return setError('A scheduled period needs an amount and unit.');
    // Same trigger and actor need an explicit order; place the new rule after existing ones.
    const after = framework.rules.filter(r => r.trigger === d.trigger && r.actorId === d.actorId).map(r => r.id);
    update(p => {
      const f = p.frameworks.find(x => x.id === d.frameworkId)!;
      if (deadlineId) (p.deadlines as unknown[]).push({ id: deadlineId, label: d.deadlineAmount + ' ' + d.deadlineUnit.replace('-', ' ') + 's', calendarId: p.calendars[0]?.id ?? 'civil', amount: Number(d.deadlineAmount), unit: d.deadlineUnit,
        startCounting: 'exclude-trigger', monthEnd: 'clamp', nonBusinessDue: 'extend', sourceRefs: [{ ...ref, source: f.sourceId }] });
      (f.rules as unknown[]).push({ id: d.id, modal: d.modal, sourceRefs: [ref], trigger: d.trigger, when, exceptions: d.exceptionFact ? [fact(d.exceptionFact)] : [], operation: d.operation, actorId: d.actorId,
        explanationKey: d.id, ...(after.length ? { after: [after.at(-1)!] } : {}), effect });
      (p.explanations as Record<string, unknown>)[d.id] = { plain: d.plain.trim(), detail: d.detail.trim() };
      const cov = f.coverage as { provision: string; mode: string }[];
      const existing = cov.find(c => c.provision === d.provision);
      if (existing) existing.mode = 'modeled'; else cov.push({ provision: d.provision, mode: 'modeled' });
    });
    setError(''); setD(emptyRule(d.frameworkId));
  };
  const markRest = () => update(p => {
    const f = p.frameworks.find(x => x.id === d.frameworkId);
    if (!f) return;
    const cov = f.coverage as { provision: string; mode: string }[];
    for (const pr of sourceProvisions(f.sourceId)) if (!cov.some(c => c.provision === pr.path)) cov.push({ provision: pr.path, mode: 'explanatory-only' });
  });
  return <div className="two-col">
    <section className="author-card" aria-labelledby="rb-h"><h2 id="rb-h">Add a rule</h2>
      <div className="control"><label className="control__label" htmlFor="r-fw">Framework</label><select id="r-fw" value={d.frameworkId} onChange={e => set('frameworkId')(e.target.value)}>{payload.frameworks.map(f => <option key={f.id} value={f.id}>{f.label || f.id}</option>)}</select></div>
      <Field id="r-id" label="Rule ID" value={d.id} onChange={set('id')} />
      <div className="control"><label className="control__label" htmlFor="r-modal">Legal force</label><select id="r-modal" value={d.modal} onChange={e => set('modal')(e.target.value as RuleDraft['modal'])}>{['obligation', 'permission', 'prohibition', 'right', 'power'].map(m => <option key={m}>{m}</option>)}</select></div>
      <div className="control"><label className="control__label" htmlFor="r-op">What the rule does</label><select id="r-op" value={d.operation} onChange={e => set('operation')(e.target.value as RuleDraft['operation'])}>
        <option value="create-obligation">Creates a duty someone must perform</option><option value="record">Records a legal result (status, fact or transfer)</option><option value="schedule">Starts a period that ends later</option><option value="route">Moves an item to another actor</option></select></div>
      <Field id="r-trig" label="Triggering event kind" value={d.trigger} onChange={set('trigger')} help="An event from a scenario (e.g. application-filed) or one another rule emits." />
      <div className="control"><label className="control__label" htmlFor="r-actor">Actor</label><select id="r-actor" value={d.actorId} onChange={e => set('actorId')(e.target.value)}><option value="">Choose…</option>{payload.actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
      <fieldset className="conditions"><legend>Conditions (all must hold; unknown facts stay unknown)</legend>
        {d.conditions.map((c, i) => <div key={i} className="cond-row"><select aria-label="Fact" value={c.fact} onChange={e => setD(x => ({ ...x, conditions: x.conditions.map((y, j) => j === i ? { ...y, fact: e.target.value } : y) }))}>{payload.facts.filter(f => f.type === 'boolean').map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
          <select aria-label="Must be" value={c.value} onChange={e => setD(x => ({ ...x, conditions: x.conditions.map((y, j) => j === i ? { ...y, value: e.target.value as 'true' } : y) }))}><option value="true">is true</option><option value="false">is false</option></select>
          <button type="button" className="linklike" onClick={() => setD(x => ({ ...x, conditions: x.conditions.filter((_, j) => j !== i) }))}>Remove</button></div>)}
        <button type="button" className="linklike" disabled={!payload.facts.some(f => f.type === 'boolean')} onClick={() => setD(x => ({ ...x, conditions: [...x.conditions, { fact: payload.facts.find(f => f.type === 'boolean')!.id, value: 'true' }] }))}>Add condition</button>
      </fieldset>
      <div className="control"><label className="control__label" htmlFor="r-prov">Provision</label><select id="r-prov" value={d.provision} onChange={e => set('provision')(e.target.value)}><option value="">Choose…</option>{provs.map(p => <option key={p.path} value={p.path}>{p.citation}</option>)}</select>
        {chosen && <p className="provision-text small">{chosen.text}</p>}</div>
      <Field id="r-quote" label="Exact quote supporting this rule" value={d.quote} onChange={set('quote')} multiline help={d.quote ? (quoteOk ? '✓ Found verbatim in the provision.' : '✗ Not found verbatim — copy the words exactly.') : 'Copy the words from the provision text above.'} />
      {(d.operation === 'create-obligation' || d.operation === 'schedule') && <div className="cond-row"><Field id="r-amt" label="Deadline amount" type="number" value={d.deadlineAmount} onChange={set('deadlineAmount')} />
        <div className="control"><label className="control__label" htmlFor="r-unit">Unit</label><select id="r-unit" value={d.deadlineUnit} onChange={e => set('deadlineUnit')(e.target.value as RuleDraft['deadlineUnit'])}><option value="business-day">business days</option><option value="calendar-day">calendar days</option><option value="calendar-month">calendar months</option></select></div></div>}
      {d.operation === 'create-obligation' && <><Field id="r-action" label="Action owed (used by behavior assumptions)" value={d.action} onChange={set('action')} /><Field id="r-perf" label="Event emitted when performed" value={d.onPerform} onChange={set('onPerform')} /><Field id="r-breach" label="Event emitted when the deadline passes (optional)" value={d.onBreach} onChange={set('onBreach')} /></>}
      {d.operation !== 'create-obligation' && <Field id="r-emits" label="Event emitted (optional for records)" value={d.emits} onChange={set('emits')} />}
      {d.operation === 'route' && <div className="control"><label className="control__label" htmlFor="r-to">Route to</label><select id="r-to" value={d.routeTo} onChange={e => set('routeTo')(e.target.value)}><option value="">Choose…</option>{payload.actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}
      <Field id="r-cp" label="Checkpoint name for comparisons (optional)" value={d.checkpoint} onChange={set('checkpoint')} help="Use the same name in both frameworks for the same legal step." />
      <div className="control"><label className="control__label" htmlFor="r-exc">Exception fact (optional)</label><select id="r-exc" value={d.exceptionFact} onChange={e => set('exceptionFact')(e.target.value)}><option value="">None</option>{payload.facts.filter(f => f.type === 'boolean').map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>
      {d.exceptionFact && <Field id="r-excl" label="Exception label" value={d.exceptionLabel} onChange={set('exceptionLabel')} />}
      <Field id="r-eff" label="Takes effect this many days after enactment (proposals only, optional)" type="number" value={d.effectiveAfter} onChange={set('effectiveAfter')} />
      <Field id="r-sum" label="Summary" value={d.summary} onChange={set('summary')} /><Field id="r-plain" label="Plain explanation" value={d.plain} onChange={set('plain')} multiline /><Field id="r-detail" label="Detailed explanation" value={d.detail} onChange={set('detail')} multiline />
      {error && <p className="control__error" role="alert">{error}</p>}
      <button type="button" className="lm-button lm-button--primary" onClick={add}>Add rule</button>
    </section>
    <section className="author-card" aria-labelledby="rl-h"><h2 id="rl-h">Rules and coverage</h2>
      {payload.frameworks.map(f => <div key={f.id}><h3>{f.label || f.id}</h3>
        <ul>{f.rules.map(r => <li key={r.id}><code>{r.id}</code> — {r.effect.summary} <button type="button" className="linklike" onClick={() => update(p => { const fr = p.frameworks.find(x => x.id === f.id)!; (fr.rules as unknown[]).splice(fr.rules.findIndex(x => x.id === r.id), 1); })}>Remove</button></li>)}</ul>
        <p className="muted small">{f.coverage.length} of {sourceProvisions(f.sourceId).length} provisions have a coverage declaration.</p>
      </div>)}
      <button type="button" className="lm-button lm-button--secondary" onClick={markRest}>Mark undeclared provisions of this framework “explanation only”</button>
      <p className="muted small">Review these: ambiguous or unsupported provisions should say why (edit in the JSON tab).</p>
    </section>
  </div>;
}

function Scenarios({ payload, update }: { payload: AuthoredPack; update: (fn: (p: AuthoredPack) => void) => void }) {
  const actions = useMemo(() => [...new Set(payload.frameworks.flatMap(f => f.rules.flatMap(r => r.effect.kind === 'create-obligation' ? [r.effect.action] : [])))], [payload]);
  const checkpoints = useMemo(() => [...new Set(payload.frameworks.flatMap(f => f.rules.flatMap(r => r.effect.checkpoint ? [r.effect.checkpoint] : [])))], [payload]);
  const blank = { id: '', title: '', question: '', summary: '', startDate: '', horizonDays: '120', facts: {} as Record<string, string>, events: [] as { day: string; kind: string; actorId: string; label: string }[],
    behaviors: {} as Record<string, string>, expected: [] as { frameworkId: string; checkpoint: string; present: boolean; eventDate: string; dueDate: string; dutyState: string; reasoning: string }[], learn: '' };
  const [s, setS] = useState(blank);
  const [error, setError] = useState('');
  const add = () => {
    if (!ID.test(s.id) || !s.title || !s.question || !s.summary || !/^\d{4}-\d{2}-\d{2}$/.test(s.startDate)) return setError('Fill in ID, title, question, summary and start date.');
    if (!s.events.length) return setError('Add at least one scenario event.');
    if (payload.frameworks.some(f => !s.expected.some(x => x.frameworkId === f.id))) return setError('Write at least one independent expectation for each framework.');
    if (s.expected.some(x => !x.reasoning.trim())) return setError('Each expectation needs the reasoning behind it, worked out from the text, not from the engine.');
    const facts: Record<string, boolean | number | string> = {};
    for (const [k, v] of Object.entries(s.facts)) { const f = payload.facts.find(x => x.id === k); if (!f || v === '') continue; facts[k] = f.type === 'boolean' ? v === 'true' : f.type === 'number' ? Number(v) : v; }
    const behaviors = Object.entries(s.behaviors).filter(([, v]) => v !== '').map(([action, v]) => ({ action, mode: 'perform-after', delay: { amount: Number(v), unit: 'business-day' }, assumptionId: 'assume-' + action }));
    const scenario: ScenarioSpec = { id: s.id, title: s.title, question: s.question, summary: s.summary, hypothetical: true, startDate: s.startDate, calendarId: payload.calendars[0]?.id ?? 'civil', seed: 1, horizonDays: Number(s.horizonDays) || 120,
      enactment: { assume: true, offsetDays: -400 }, facts, unknownFacts: payload.facts.filter(f => s.facts[f.id] === '?').map(f => ({ factId: f.id, reason: 'Left unknown in this scenario' })), interpretationChoices: {},
      events: s.events.map((e, i) => ({ id: 'e' + (i + 1), day: Number(e.day) || 0, kind: e.kind, actorId: e.actorId, label: e.label })), behaviors: behaviors as ScenarioSpec['behaviors'],
      parameters: behaviors.map(b => ({ id: b.action + '-delay', label: 'Business days to ' + b.action.replace(/-/g, ' '), help: 'An operational assumption, separate from the law.', control: 'integer' as const, min: 0, max: 60, unit: 'business days', target: { kind: 'behavior-delay' as const, action: b.action }, assumptionId: b.assumptionId })),
      assumptions: behaviors.map(b => b.assumptionId), unresolved: [], learn: s.learn ? [s.learn] : [],
      expected: Object.fromEntries(payload.frameworks.map(f => [f.id, s.expected.filter(x => x.frameworkId === f.id).map(x => ({ checkpoint: x.checkpoint, present: x.present, reasoning: x.reasoning,
        ...(x.eventDate ? { eventDate: x.eventDate } : {}), ...(x.dueDate ? { dueDate: x.dueDate } : {}), ...(x.dutyState ? { dutyState: x.dutyState as 'pending' } : {}) }))])) };
    update(p => {
      for (const b of behaviors) if (!p.assumptions.some(a => a.id === b.assumptionId)) (p.assumptions as unknown[]).push({ id: b.assumptionId, label: 'Time to ' + b.action.replace(/-/g, ' '), description: 'How long the actor takes. This is behavior, not law.', classification: 'hypothetical', limitations: ['Illustrative only.'] });
      (p.scenarios as unknown[]).push(scenario);
    });
    setError(''); setS(blank);
  };
  return <div className="two-col">
    <section className="author-card" aria-labelledby="sb-h"><h2 id="sb-h">Add a scenario</h2>
      <p className="muted small">Scenarios use hypothetical facts only. Expectations must be worked out independently from the text so the validator can catch modeling mistakes.</p>
      <Field id="s-id" label="ID" value={s.id} onChange={v => setS(x => ({ ...x, id: v }))} /><Field id="s-title" label="Title" value={s.title} onChange={v => setS(x => ({ ...x, title: v }))} />
      <Field id="s-q" label="Question" value={s.question} onChange={v => setS(x => ({ ...x, question: v }))} /><Field id="s-sum" label="Summary" value={s.summary} onChange={v => setS(x => ({ ...x, summary: v }))} multiline />
      <Field id="s-start" label="Start date" type="date" value={s.startDate} onChange={v => setS(x => ({ ...x, startDate: v }))} /><Field id="s-h" label="Horizon (days)" type="number" value={s.horizonDays} onChange={v => setS(x => ({ ...x, horizonDays: v }))} />
      <fieldset><legend>Facts</legend>{payload.facts.map(f => <div key={f.id} className="control"><label className="control__label" htmlFor={'sf-' + f.id}>{f.label}</label>
        {f.type === 'boolean' ? <select id={'sf-' + f.id} value={s.facts[f.id] ?? ''} onChange={e => setS(x => ({ ...x, facts: { ...x.facts, [f.id]: e.target.value } }))}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option><option value="?">Unknown</option></select>
          : <input id={'sf-' + f.id} value={s.facts[f.id] ?? ''} onChange={e => setS(x => ({ ...x, facts: { ...x.facts, [f.id]: e.target.value } }))} />}</div>)}</fieldset>
      <fieldset><legend>Events</legend>{s.events.map((e, i) => <div key={i} className="cond-row">
        <input aria-label="Day" type="number" value={e.day} onChange={v => setS(x => ({ ...x, events: x.events.map((y, j) => j === i ? { ...y, day: v.target.value } : y) }))} />
        <input aria-label="Event kind" value={e.kind} placeholder="kind" onChange={v => setS(x => ({ ...x, events: x.events.map((y, j) => j === i ? { ...y, kind: v.target.value } : y) }))} />
        <select aria-label="Actor" value={e.actorId} onChange={v => setS(x => ({ ...x, events: x.events.map((y, j) => j === i ? { ...y, actorId: v.target.value } : y) }))}><option value="">Actor…</option>{payload.actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <input aria-label="Label" value={e.label} placeholder="label" onChange={v => setS(x => ({ ...x, events: x.events.map((y, j) => j === i ? { ...y, label: v.target.value } : y) }))} /></div>)}
        <button type="button" className="linklike" onClick={() => setS(x => ({ ...x, events: [...x.events, { day: '0', kind: '', actorId: payload.actors[0]?.id ?? '', label: '' }] }))}>Add event</button></fieldset>
      <fieldset><legend>Behavior assumptions (business days to perform)</legend>{actions.map(a => <div key={a} className="control"><label className="control__label" htmlFor={'sb-' + a}>{a}</label><input id={'sb-' + a} type="number" value={s.behaviors[a] ?? ''} onChange={e => setS(x => ({ ...x, behaviors: { ...x.behaviors, [a]: e.target.value } }))} /></div>)}</fieldset>
      <fieldset><legend>Independent expectations</legend>{s.expected.map((x, i) => <div key={i} className="expect-row">
        <select aria-label="Framework" value={x.frameworkId} onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, frameworkId: e.target.value } : z) }))}>{payload.frameworks.map(f => <option key={f.id} value={f.id}>{f.id}</option>)}</select>
        <select aria-label="Checkpoint" value={x.checkpoint} onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, checkpoint: e.target.value } : z) }))}>{checkpoints.map(c => <option key={c}>{c}</option>)}</select>
        <label><input type="checkbox" checked={x.present} onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, present: e.target.checked } : z) }))} /> occurs</label>
        <input aria-label="Event date" type="date" value={x.eventDate} onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, eventDate: e.target.value } : z) }))} />
        <input aria-label="Due date" type="date" value={x.dueDate} onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, dueDate: e.target.value } : z) }))} />
        <select aria-label="Duty state" value={x.dutyState} onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, dutyState: e.target.value } : z) }))}><option value="">Duty state…</option>{['none', 'pending', 'satisfied', 'breached', 'unknown'].map(v => <option key={v}>{v}</option>)}</select>
        <input aria-label="Reasoning" value={x.reasoning} placeholder="Why, from the text" onChange={e => setS(y => ({ ...y, expected: y.expected.map((z, j) => j === i ? { ...z, reasoning: e.target.value } : z) }))} /></div>)}
        <button type="button" className="linklike" disabled={!checkpoints.length} onClick={() => setS(y => ({ ...y, expected: [...y.expected, { frameworkId: payload.frameworks[0]?.id ?? '', checkpoint: checkpoints[0] ?? '', present: true, eventDate: '', dueDate: '', dutyState: '', reasoning: '' }] }))}>Add expectation</button></fieldset>
      <Field id="s-learn" label="What a visitor learns (optional)" value={s.learn} onChange={v => setS(x => ({ ...x, learn: v }))} />
      {error && <p className="control__error" role="alert">{error}</p>}
      <button type="button" className="lm-button lm-button--primary" onClick={add}>Add scenario</button>
    </section>
    <section className="author-card" aria-labelledby="sl-h"><h2 id="sl-h">Scenarios</h2>
      <ul>{payload.scenarios.map(x => <li key={x.id}><code>{x.id}</code> — {x.title} <button type="button" className="linklike" onClick={() => update(p => { (p.scenarios as unknown[]).splice(p.scenarios.findIndex(y => y.id === x.id), 1); })}>Remove</button></li>)}</ul>
    </section>
  </div>;
}

function JsonEditor({ payload, onApply }: { payload: AuthoredPack; onApply: (p: AuthoredPack) => void }) {
  const [text, setText] = useState(() => JSON.stringify(payload, null, 2));
  const [error, setError] = useState('');
  useEffect(() => { setText(JSON.stringify(payload, null, 2)); }, [payload]);
  return <section aria-labelledby="json-h"><h2 id="json-h">Full model (JSON)</h2>
    <p className="muted small">Every part of the model, including fields the forms do not cover (scene layout, glossary, interpretations, parameters). The server validates everything; nothing here can run code.</p>
    <label className="visually-hidden" htmlFor="json-text">Model JSON</label>
    <textarea id="json-text" className="json-editor" value={text} spellCheck={false} onChange={e => setText(e.target.value)} />
    {error && <p className="control__error" role="alert">{error}</p>}
    <button type="button" className="lm-button lm-button--secondary" onClick={() => { try { const p = JSON.parse(text); if (p?.format !== 'law-machine-pack-v1') throw Error('format must be law-machine-pack-v1'); setError(''); onApply(p); } catch (e) { setError('Not applied: ' + (e as Error).message); } }}>Apply JSON</button>
  </section>;
}

function Publish({ org, doc, data, dirty, save, setMessage, reload }: { org: string; doc: string; data: PackData; dirty: boolean; save: () => Promise<boolean>; setMessage: (m: string) => void; reload: () => Promise<void> }) {
  const base = '/api/v1/author/' + org + '/packs/' + doc;
  const latest = data.validations[0] as Row | undefined;
  const report = latest?.report as { diagnostics?: { code: string; path: string; message: string }[]; golden?: { total: number; failed: { checkpoint: string; expected: string; actual: string; reasoning: string }[] }; coverage?: { frameworkId: string; statement: string }[]; reason?: string } | undefined;
  const [preview, setPreview] = useState<{ release: PackRelease; runs: { scenario: string; framework: string; run: PackRun }[] } | null>(null);
  const [note, setNote] = useState('');
  const validate = async () => {
    if (dirty && !(await save())) return;
    try { const r = await api<{ jobId: string }>(base + '/validate', { body: {} }); const job = await pollJob(org, r.jobId, s => setMessage('Validation ' + s + '…')); setMessage(job.state === 'completed' ? ((job.result as Row).valid ? 'Valid. A staged build is ready to preview and publish.' : 'Validation found problems; see the report.') : 'Validation job failed (' + String(job.last_error_code) + ').'); await reload(); }
    catch (e) { setMessage(explain(e)); }
  };
  const showPreview = async (digest: string) => {
    try {
      const release = await api<PackRelease>(base + '/preview/' + digest);
      setPreview({ release, runs: release.scenarios.flatMap(s => release.frameworks.map(f => ({ scenario: s.title, framework: f.label, run: runPackScenario(release, f.id, s) }))) });
    } catch (e) { setMessage(explain(e)); }
  };
  const act = async (path: string, body: unknown, ok: string) => { try { await withReauth(() => api(base + path, { body })); setMessage(ok); await reload(); } catch (e) { setMessage(explain(e)); } };
  return <>
    <section className="author-card" aria-labelledby="val-h"><h2 id="val-h">Validate</h2>
      <p className="muted small">Validation runs in a background job: it rebuilds the release from the exact stored sources, checks every quote, coverage declaration and rule conflict, then runs every scenario against its independent expectations.</p>
      <button type="button" className="lm-button lm-button--primary" onClick={() => void validate()}>{dirty ? 'Save and validate' : 'Validate this revision'}</button>
      {latest && <div className="report"><h3>Latest report — revision {String(latest.revision)}{Number(latest.revision) !== data.revision ? ' (older than the current revision)' : ''}: {latest.valid ? 'valid' : 'not valid'}</h3>
        {report?.reason && <p>{report.reason}</p>}
        {!!report?.diagnostics?.length && <ul className="diagnostics">{report.diagnostics.map((d, i) => <li key={i}><code>{d.code}</code> {d.path} — {d.message}</li>)}</ul>}
        {report?.golden && <p>Expectations: {report.golden.total - report.golden.failed.length} of {report.golden.total} matched.</p>}
        {!!report?.golden?.failed.length && <ul className="diagnostics">{report.golden.failed.map((g, i) => <li key={i}><strong>{g.checkpoint}</strong>: expected {g.expected}, got {g.actual}. <span className="muted">{g.reasoning}</span></li>)}</ul>}
        {report?.coverage?.map(c => <p key={c.frameworkId} className="small">{c.frameworkId}: {c.statement}</p>)}
      </div>}
    </section>
    <section className="author-card" aria-labelledby="rel-h"><h2 id="rel-h">Releases</h2>
      {data.releases.length === 0 ? <p>No builds yet. Validate to create one.</p> : <ul className="release-list">{data.releases.map(r => {
        const id = String(r.id), digest = String(r.manifest_digest), current = (data.pointer as Row | null)?.manifest_digest === digest;
        return <li key={id}><strong>{String(r.label)}</strong> · {String(r.status)}{current ? ' · public now' : ''} · revision {String(r.revision)} · <code>{digest.slice(0, 12)}</code>{r.signed ? ' · signed' : ''}
          <div className="source-actions">
            <button type="button" className="linklike" onClick={() => void showPreview(digest)}>Preview privately</button>
            {r.status === 'staged' && <button type="button" className="linklike" onClick={() => void act('/publish', { releaseId: id }, 'Published. The public pointer now names this release.')}>Publish</button>}
            {r.status === 'published' && !current && <button type="button" className="linklike" onClick={() => void act('/pointer', { releaseId: id }, 'Public pointer restored to this release.')}>Make this the public version (roll back)</button>}
            {r.status === 'published' && <><label className="visually-hidden" htmlFor={'note-' + id}>Withdrawal note</label><input id={'note-' + id} placeholder="Reason for withdrawal" value={note} onChange={e => setNote(e.target.value.slice(0, 500))} />
              <button type="button" className="linklike" disabled={!note.trim()} onClick={() => void act('/withdraw', { releaseId: id, note }, 'Withdrawn. Links to it now say it was withdrawn.')}>Withdraw</button></>}
            {r.status !== 'staged' && <a href={'/packs/' + data.packId + '?r=' + digest}>Public page</a>}
          </div></li>;
      })}</ul>}
      <p className="muted small">Publishing needs the publisher role and a passkey confirmation within the last 15 minutes. It re-checks every asset and switches the public pointer in one transaction.</p>
    </section>
    {preview && <section className="author-card" aria-labelledby="pv-h"><h2 id="pv-h">Private preview (not public, not cached)</h2>
      {preview.runs.map((r, i) => <details key={i}><summary>{r.scenario} — {r.framework}: {r.run.state}, {r.run.events.length} steps</summary>
        <ol className="small">{r.run.events.map(e => <li key={e.id}>{e.date}: {e.label}{e.outcome === 'breached' ? ' (breached)' : e.outcome === 'unknown' ? ' (unresolved)' : ''}</li>)}</ol></details>)}
    </section>}
  </>;
}

function Suggestions({ org, doc, onUse, setMessage }: { org: string; doc: string; onUse: (d: Partial<RuleDraft>) => void; setMessage: (m: string) => void }) {
  const base = '/api/v1/author/' + org + '/packs/' + doc;
  const [items, setItems] = useState<Row[] | null>(null);
  const load = useCallback(async () => { try { setItems(await api<Row[]>(base + '/candidates')); } catch (e) { setMessage(explain(e)); } }, [base, setMessage]);
  useEffect(() => { void load(); }, [load]);
  const decide = async (id: string, disposition: 'accepted' | 'rejected', c: Row) => {
    try { await api(base + '/candidates/' + id, { body: { disposition } }); if (disposition === 'accepted') { const d = c.deadline as { amount: number; unit: RuleDraft['deadlineUnit'] } | null;
      onUse({ provision: String(c.provisionPath), quote: String(c.quote), modal: c.modal as RuleDraft['modal'], summary: String(c.summary), ...(d ? { deadlineAmount: String(d.amount), deadlineUnit: d.unit } : {}) }); }
      await load(); } catch (e) { setMessage(explain(e)); }
  };
  if (!items) return <p>Loading…</p>;
  return <section aria-labelledby="sg-h"><h2 id="sg-h">Suggested rules</h2>
    <p className="muted small">Suggestions are candidates only. Each quotes its provision exactly. Accepting one opens it in the rule builder for you to complete and check; nothing is added to the model automatically.</p>
    {items.length === 0 ? <p>No suggestions. Use “Suggest rules” on a parsed source (when enabled on this deployment).</p> :
      <ul className="candidates">{items.map(i => { const c = i.candidate as Row; return <li key={String(i.id)}><strong>{String(c.modal)}</strong> · {String(c.provisionPath)} · {String(c.confidence)} confidence · {String(i.provider)}/{String(i.model)} · {String(i.disposition)}
        <blockquote>“{String(c.quote)}”</blockquote><p>{String(c.summary)}</p>
        {i.disposition === 'pending' && <><button type="button" className="linklike" onClick={() => void decide(String(i.id), 'accepted', c)}>Accept into rule builder</button> <button type="button" className="linklike" onClick={() => void decide(String(i.id), 'rejected', c)}>Reject</button></>}</li>; })}</ul>}
  </section>;
}
