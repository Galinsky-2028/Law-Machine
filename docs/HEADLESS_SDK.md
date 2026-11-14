# Headless SDK (LM-006, LM-059)

`packages/sdk` is a framework-free TypeScript library. It imports no React, Next.js, database client or provider SDK. It lets another application load a signed, published pack release, verify it and run scenarios exactly as the public explorer does. Ask Bill or any other consumer uses this boundary; it never reaches into the web app.

```ts
import { fetchPackRelease } from '@law-machine/sdk';
// Pin the trust store you obtained out of band (the site also serves /releases/trust.json).
const session = await fetchPackRelease(base + '/releases', 'meridian-claims', manifestDigest, { trust, requireSignature: true });
const { run, prepared } = session.runScenario('wrong-agency', { frameworkId: 'proposal', params: { 'transfer-delay': 4 } });
session.resolveCitation(anchor);                       // exact provision text in the pinned version
session.getTraceExplanation(run, run.events.at(-1).id); // why an event happened
await session.compare('wrong-agency');                 // baseline vs proposal
await session.stress('wrong-agency', request);         // bounded seeded sensitivity runs
session.getSceneFocusTarget({ kind: 'actor', id: 'claimant' }, run);
session.search('transfer');
await session.exportRun(prepared, run);                // reproducible export; the server can verify it
```

## Guarantees

- **Integrity.** `fetchPackRelease` hashes every file against the manifest, and the canonical manifest against the digest you pinned.
- **Signatures.** With `requireSignature: true`, an unsigned release, or one signed by an unknown, retired-for-signing or revoked key, fails with `SIGNATURE_REQUIRED` or `INTEGRITY_FAILED`.
- **Compatibility.** Engine and schema versions are negotiated (`INCOMPATIBLE_ENGINE`, `INCOMPATIBLE_SCHEMA`).
- **Determinism.** Runs are deterministic. `run.runId` and `traceDigest` match the browser and the server verifier, so `POST /api/v1/runs/verify` can recompute any exported run.
- **No legal effect.** Nothing creates a filing, receipt, personal deadline or legal conclusion. Fictional packs are labelled `fictional: true`.

The original LM-006 `loadPublicRelease` (planning-model loader) remains exported for compatibility.

## Proof

`pnpm smoke:sdk` (part of `pnpm check`) acts as an external consumer. Against the generated public tree it:

- fetches each committed pack,
- requires a signature,
- runs every scenario,
- resolves pinned citations,
- requests focus targets,
- searches.
