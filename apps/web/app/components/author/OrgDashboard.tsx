'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, explain, signIn } from '../../lib/author-client.ts';

type Pack = { documentId: string; packId: string; title: string; revision: number; updatedAt: string; valid: boolean | null; published: string | null };
type Member = { actorId: string; displayName: string; role: string; revokedAt: string | null };
type Me = { actorId: string; memberships: { organizationId: string; slug: string; role: string }[] };

/** Calls that need recent passkey confirmation retry once after reauthentication. */
export async function withReauth<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') { await signIn(); return fn(); } throw e; }
}

export function OrgDashboard({ org }: { org: string }) {
  const base = '/api/v1/author/' + org;
  const [me, setMe] = useState<Me | null>(null);
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [diag, setDiag] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ packId: '', title: '' });
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [role, setRole] = useState('editor');
  const load = useCallback(async () => {
    try {
      const [m, p, mem] = await Promise.all([api<Me>('/api/author/me'), api<Pack[]>(base + '/packs'), api<Member[]>(base + '/members')]);
      setMe(m); setPacks(p); setMembers(mem);
    } catch (e) { setMessage(explain(e)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  const myRole = me?.memberships.find(m => m.organizationId === org)?.role;
  const slug = me?.memberships.find(m => m.organizationId === org)?.slug ?? 'Organization';
  const act = async (fn: () => Promise<unknown>, ok: string) => { setMessage('Working…'); try { await fn(); setMessage(ok); await load(); } catch (e) { setMessage(explain(e)); } };
  return <>
    <h1>{slug}</h1>
    <p className="muted">Your role: {myRole ?? '…'}</p>
    <p role="status" className="author-status">{message}</p>
    <section aria-labelledby="packs-h" className="author-card"><h2 id="packs-h">Models</h2>
      {packs === null ? <p>Loading…</p> : packs.length === 0 ? <p>No models yet.</p> :
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Models table"><table><thead><tr><th scope="col">Model</th><th scope="col">Pack ID</th><th scope="col">Revision</th><th scope="col">Validation</th><th scope="col">Public</th></tr></thead>
          <tbody>{packs.map(p => <tr key={p.documentId}><th scope="row"><a href={'/author/' + org + '/packs/' + p.documentId}>{p.title}</a></th><td><code>{p.packId}</code></td><td>{p.revision}</td>
            <td>{p.valid === null ? 'Not validated' : p.valid ? 'Valid' : 'Has problems'}</td><td>{p.published ? <a href={'/packs/' + p.packId}>Published</a> : 'Not published'}</td></tr>)}</tbody></table></div>}
      <form className="inline-form" onSubmit={e => { e.preventDefault(); void act(async () => { const r = await api<{ documentId: string }>(base + '/packs', { body: form }); window.location.href = '/author/' + org + '/packs/' + r.documentId; }, 'Created.'); }}>
        <h3>Start a new model</h3>
        <div className="control"><label className="control__label" htmlFor="np-id">Pack ID (lowercase letters, numbers, dashes)</label><input id="np-id" value={form.packId} pattern="[a-z0-9][a-z0-9-]{0,79}" required onChange={e => setForm(f => ({ ...f, packId: e.target.value }))} /></div>
        <div className="control"><label className="control__label" htmlFor="np-title">Title</label><input id="np-title" value={form.title} required maxLength={200} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></div>
        <button type="submit" className="lm-button lm-button--primary">Create model</button>
      </form>
    </section>
    <section aria-labelledby="mem-h" className="author-card"><h2 id="mem-h">Members</h2>
      <ul className="members">{members.map(m => <li key={m.actorId}>{m.displayName} — {m.role}{m.revokedAt ? ' (revoked ' + m.revokedAt.slice(0, 10) + ')' : ''}
        {myRole === 'publisher' && !m.revokedAt && m.actorId !== me?.actorId && <> <button type="button" className="linklike" onClick={() => act(() => withReauth(() => api(base + '/members/' + m.actorId + '/revoke', { body: {} })), 'Access revoked; their sessions ended.')}>Revoke access</button></>}</li>)}</ul>
      {myRole === 'publisher' && <form className="inline-form" onSubmit={e => { e.preventDefault(); void act(async () => setInvite(await withReauth(() => api<{ code: string; expiresAt: string }>(base + '/invitations', { body: { role } }))), 'Invitation created.'); }}>
        <div className="control"><label className="control__label" htmlFor="inv-role">Invite someone as</label>
          <select id="inv-role" value={role} onChange={e => setRole(e.target.value)}><option value="contributor">Contributor (edit drafts)</option><option value="editor">Editor (edit and validate)</option><option value="publisher">Publisher (also publish and manage members)</option></select></div>
        <button type="submit" className="lm-button lm-button--secondary">Create invitation code</button>
        {invite && <p className="invite-code" role="note">Give this one-time code to the person you invite. It is shown only now and expires {invite.expiresAt.slice(0, 10)}: <code>{invite.code}</code></p>}
      </form>}
    </section>
    <section aria-labelledby="diag-h" className="author-card"><h2 id="diag-h">Diagnostics</h2>
      <button type="button" className="lm-button lm-button--secondary" onClick={async () => { try { setDiag(await api(base + '/diagnostics')); } catch (e) { setMessage(explain(e)); } }}>Show service and queue status</button>
      {diag !== null && <pre className="json-view">{JSON.stringify(diag, null, 2)}</pre>}
    </section>
  </>;
}
