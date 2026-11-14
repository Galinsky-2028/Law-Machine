# Operations runbook (LM-052–LM-057, LM-060)

The Law Machine runs in two modes:

- **Static/public mode** (`pnpm export:static` → `dist/static`). This needs no database or secrets. It covers committed signed packs, the in-browser simulation, search, stress testing and share links. Server verification and server saves report "unavailable".
- **Service mode** (`pnpm build && pnpm start`, a Node 24 web service). This adds the database-backed authoring, publication, server verification and saved scenarios. The durable job worker runs inside the same process (`instrumentation.ts`).

Public reading never depends on the database. `/api/health` reports `status` from the published releases, and `database`/`authoring` separately.

## Environment inventory

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | authoring, saves, verification records | `lm_app_login` (NOBYPASSRLS) via the pooled endpoint |
| `AUTH_DATABASE_URL` | passkey sign-in/sessions | `lm_auth_login` (NOBYPASSRLS); identity tables only |
| `MIGRATION_DATABASE_URL` | migrations at start | Owner role on the **direct** (non-pooler) endpoint; used only by the migration runner |
| `LM_MIGRATE_ON_START=1` | migrate before serving | Advisory-locked; checksum drift aborts start |
| `LM_APP_DB_PASSWORD`, `LM_AUTH_DB_PASSWORD` | login roles | The migration runner creates or rotates `lm_app_login`/`lm_auth_login` with these |
| `LM_BOOTSTRAP_INVITE_DIGEST`, `LM_BOOTSTRAP_ORG` | first owner | SHA-256 (hex) of a one-time invitation code for the first publisher; it is consumed on use |
| `LM_AUTH_MODE=passkey` | authoring UI | Without it, authoring is reported disabled |
| `LM_ORIGIN` | WebAuthn RP ID / origin, CSRF origin | e.g. `https://law-machine.onrender.com` |
| `LM_SOURCE_KEY` | private source envelopes | 32 random bytes, base64 (AES-256-GCM). **Losing it makes stored drafts' sources unreadable.** |
| `LM_RELEASE_SIGNING_KEY`, `LM_RELEASE_KEY_ID` | signing authored releases | Private P-256 JWK (JSON) whose public key is in `content/trust/release-keys.json` |
| `LM_VERIFIER_KEY`, `LM_VERIFIER_KEY_ID` | optional signed verification records | Private P-256 JWK; signs `/api/v1/runs/verify` records (ECDSA) |
| `LM_BACKUP_KEY` | backup/restore | 32 bytes base64; keep it apart from the database credentials |
| `LM_AI_ENABLED=1`, `LM_AI_PROVIDER=claude\|heuristic`, `ANTHROPIC_API_KEY` | optional AI candidates | Off by default. Unsetting `LM_AI_ENABLED` is the kill switch. |
| `LM_WORKER=0` | disable in-process worker | For a separate worker process |

Never commit any of these. `pnpm scan:secrets` runs in `pnpm check`.

## Deploy

1. Merge to `main` only through `docs/GITHUB_MERGE_PREFLIGHT.md`. The required checks are `foundation`, `workspace`, `postgres` and `authoring` on the exact head.
2. The Render web service builds with `corepack enable && pnpm install --frozen-lockfile && pnpm build` and starts with `pnpm start`. On start the service:
   - migrates (when `LM_MIGRATE_ON_START=1`),
   - creates or rotates the login roles,
   - inserts the bootstrap invitation digest,
   - starts the worker.
3. Verify after every deploy:
   - `curl -s $ORIGIN/api/health` shows `status: ok`, `database: ok`, `authoring: enabled` and `commit` equal to the merged SHA.
   - `curl -s $ORIGIN/api/v1/catalog` shows the expected `current` digests.
   - Open one scenario and confirm the "Verified & signed" badge.

## Migrations and rollback

- Each `db/migrations/NNNN_up.sql` has a `NNNN_down.sql`. CI applies every up migration and then the whole down chain to 0001.
- The runner records checksums, so an edited applied migration aborts start (`MIGRATION_CHECKSUM_MISMATCH`).
- **Code rollback**: redeploy the previous successful Render deploy (Render → Deploys → Rollback, or `POST /v1/services/{id}/rollback`). Migrations are additive within a release, so the previous code runs against the newer schema. A destructive down migration is run manually with `MIGRATION_DATABASE_URL`, only after a backup.
- **Content rollback**: publishers use "Make current" on an earlier release (`POST …/pointer`). Pointer moves are atomic and audited. Withdrawal moves the pointer to the newest remaining published release, or marks the pack unavailable.
- Committed static packs roll back by reverting `content/releases/*/index.json`.

## Backups (LM-053)

```bash
BACKUP_DATABASE_URL="$MIGRATION_DATABASE_URL" LM_BACKUP_KEY=… pnpm db:backup ./backups
```

```bash
RESTORE_DATABASE_URL="$EMPTY_DATABASE_URL" LM_BACKUP_KEY=… pnpm db:restore ./backups/law-machine-….lmb
```

- Archives are gzip + AES-256-GCM. Each table carries a SHA-256, so corruption is refused.
- Restore only targets an **empty** database. It then migrates, re-hashes every release asset against its manifest and replays every scenario against its golden expectations.
- Evidence from CI and the local runs: restore verified 45/45 replays with consistent pointers.
- **RPO**: the time since the last backup. A weekly scheduled backup plus Neon's point-in-time history (free tier: 24 hours) bounds data loss to 24 hours.
- **RTO**: about 5 minutes for a small database (restore and replay measured in seconds) plus the deploy time.
- Signing keys are **not** in backups. Recover them from the secret store, or rotate (below).

## Release key rotation and revocation (LM-057)

1. Generate a P-256 key pair with `generateSigningKey()` from `@law-machine/contracts` (keep the private JWK only in the secret store) and add its public JWK to `content/trust/release-keys.json` with `status: active`.
2. Mark the old key `retired`. Retired keys still verify the releases they signed.
3. Deploy with the new `LM_RELEASE_SIGNING_KEY`/`LM_RELEASE_KEY_ID`, then re-sign the committed releases with `LM_RELEASE_SIGNING_KEY=… LM_RELEASE_KEY_ID=… node --import tsx scripts/packs.ts sign`.
4. If a key is compromised, mark it `revoked`. Revoked keys verify nothing, so browsers show "signature not trusted" and the SDK with `requireSignature` refuses. Re-sign with a new key and deploy.

## Diagnostics and privacy (LM-052)

- Logs are single-line JSON events with a request id, route, code and duration. They never contain draft text, source bytes, scenario parameters, cookies or IP addresses (`telemetry.ts` redaction, enforced by unit tests).
- `/api/v1/author/{org}/diagnostics` shows queue lag, failures by code and provider status to members.
- There is no third-party analytics.

## Restart during a job

- Jobs hold fenced leases. A worker that dies leaves its lease to expire, then another claim increments the fence and retries, up to the attempt limit.
- Completion with a stale fence is rejected, so a restarted service cannot double-publish a staged release.
- Covered by `tests/postgres/*.sql` and `apps/jobs` unit tests.

## Static distribution

`pnpm export:static` writes `dist/static`, a fully static site with signed release files. Any static host works. Paths are relative to the site root.
