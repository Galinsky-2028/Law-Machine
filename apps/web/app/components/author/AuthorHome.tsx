'use client';
import { useCallback, useEffect, useState } from 'react';
import { addPasskey, api, ApiError, enrollWithInvitation, explain, signIn, signOut } from '../../lib/author-client.ts';

type Me = { actorId: string; displayName: string; memberships: { organizationId: string; slug: string; role: string }[]; passkeys: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[]; reauthenticatedAt: string };
export function AuthorHome() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'signed-out' | 'signed-in' | 'disabled'>('loading');
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const load = useCallback(async () => {
    try { setMe(await api<Me>('/api/author/me')); setState('signed-in'); }
    catch (e) { setMe(null); setState(e instanceof ApiError && e.code === 'AUTHORING_DISABLED' ? 'disabled' : 'signed-out'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMessage('Waiting for your passkey…'); try { await fn(); setMessage(ok); await load(); } catch (e) { setMessage(explain(e)); } };
  if (state === 'loading') return <p role="status">Checking your session…</p>;
  if (state === 'disabled') return <><h1>Authoring</h1><p className="intro">Authoring is not enabled on this deployment. Public reading, simulation and verification work without it.</p></>;
  if (state === 'signed-out' || !me) return <>
    <h1>Authoring</h1>
    <p className="intro">Editors build and publish models here. Sign-in uses passkeys: your device confirms it is you, and no password is stored.</p>
    <section aria-labelledby="signin-h" className="author-card"><h2 id="signin-h">Sign in</h2><button type="button" className="lm-button lm-button--primary" onClick={() => run(signIn, 'Signed in.')}>Sign in with a passkey</button></section>
    <section aria-labelledby="enroll-h" className="author-card"><h2 id="enroll-h">Join with an invitation</h2>
      <form onSubmit={e => { e.preventDefault(); void run(() => enrollWithInvitation(code.trim(), name.trim()), 'Passkey created. You are signed in.'); }}>
        <div className="control"><label className="control__label" htmlFor="inv">Invitation code</label><input id="inv" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" required /></div>
        <div className="control"><label className="control__label" htmlFor="dn">Your name as shown to collaborators</label><input id="dn" value={name} onChange={e => setName(e.target.value.slice(0, 80))} required /></div>
        <button type="submit" className="lm-button lm-button--primary">Create a passkey</button>
      </form></section>
    <p role="status">{message}</p>
  </>;
  return <>
    <h1>Hello, {me.displayName}</h1>
    <section aria-labelledby="orgs-h" className="author-card"><h2 id="orgs-h">Your organizations</h2>
      {me.memberships.length ? <ul className="link-list">{me.memberships.map(m => <li key={m.organizationId}><a href={'/author/' + m.organizationId}>{m.slug}</a> — {m.role}</li>)}</ul> : <p>You have no active memberships.</p>}
    </section>
    <section aria-labelledby="pk-h" className="author-card"><h2 id="pk-h">Passkeys</h2>
      <ul>{me.passkeys.map(p => <li key={p.id}>{p.label} · added {p.createdAt.slice(0, 10)}{p.lastUsedAt ? ' · last used ' + p.lastUsedAt.slice(0, 10) : ''}</li>)}</ul>
      <button type="button" className="lm-button lm-button--secondary" onClick={() => run(addPasskey, 'Passkey added.')}>Add another passkey</button>{' '}
      <button type="button" className="lm-button lm-button--secondary" onClick={async () => { await signOut(); setMessage('Signed out.'); await load(); }}>Sign out</button>
    </section>
    <p role="status">{message}</p>
  </>;
}
