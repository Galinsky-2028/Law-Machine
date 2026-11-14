'use client';
import { useState } from 'react';

type Outcome = { valid: boolean; reason: string; record?: { verifiedAt: string; verifierKeyId: string; signature: string } };
const REASON: Record<string, string> = { RECOMPUTED_MATCH: 'The server reran the pinned model and got exactly the same result.', OUTCOME_MISMATCH: 'The recorded outcome does not match what the model produces. The file may have been edited.', RUN_IDENTITY_MISMATCH: 'The inputs do not match the recorded run identity.', RELEASE_MISMATCH: 'The file names a release that does not match.', RELEASE_UNKNOWN: 'The release in this file is not published here.', RELEASE_WITHDRAWN: 'This release was withdrawn.', PARAMETERS_INVALID: 'The settings in the file are not allowed for this scenario.', ENGINE_VERSION_UNSUPPORTED: 'This file was made by an engine version this server cannot replay exactly.', INVALID_EXPORT: 'This is not a Law Machine result file.' };
export function VerifyBox() {
  const [status, setStatus] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const onFile = async (file: File | undefined) => {
    setOutcome(null);
    if (!file) return;
    if (file.size > 200000) { setStatus('That file is too large to be a result export.'); return; }
    setStatus('Recomputing on the server…');
    const response = await fetch('/api/v1/runs/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text() }).catch(() => null);
    if (!response) { setStatus('The verification service is unavailable. Static deployments can still check files with the headless SDK.'); return; }
    const data = await response.json().catch(() => null) as Outcome | null;
    setStatus('');
    setOutcome(data ?? { valid: false, reason: 'INVALID_EXPORT' });
  };
  return <div className="verify-box">
    <label htmlFor="verify-file" className="control__label">Result file (.json)</label>
    <input id="verify-file" type="file" accept="application/json,.json" onChange={e => void onFile(e.target.files?.[0])} />
    <p role="status">{status}</p>
    {outcome && <div className={outcome.valid ? 'verify-ok' : 'error-notice'} role="alert">
      <strong>{outcome.valid ? 'Verified.' : 'Not verified.'}</strong> {REASON[outcome.reason] ?? outcome.reason}
      {outcome.record && <p className="small">Server record {outcome.record.verifiedAt}, key {outcome.record.verifierKeyId}. This confirms the computation, not legal correctness.</p>}
    </div>}
  </div>;
}
