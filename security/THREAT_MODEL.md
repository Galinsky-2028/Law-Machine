# Threat model

Scope: the full application as of the 2026-11-14 checkpoint: public explorer, pack runtime and SDK, passkey authoring, encrypted private sources, durable jobs, publication, optional AI and operations. The original foundation table is retained below; the implemented controls and their tests follow it.

| Asset / boundary | Threat | Required behavior and evidence |
| --- | --- | --- |
| Approved work plan → portfolio importer | Duplicate/missing units, wrong repository, cycles, fake completion | Strict parser, preservation tests, live real PR mapping; one canonical file |
| Source archive → active plan | Silent loss or changed acceptance criteria | Original DOCX/text digests, exact original-unit parity |
| Pull request → CI/merge | Untrusted code gets secrets or unchecked merge | Read-only CI permissions, no pull_request_target, no persisted checkout credential, pinned actions; current-head preflight |
| Source file → parser (planned) | XXE, archive bomb, active content, SSRF | Bounded isolated parsing; protocol/address/redirect checks; adversarial fixtures |
| Draft → author API/storage (planned) | Tenant escape, stale edits, preview/cache leak | Auth-derived membership, same-tenant references, revision guards, private no-store previews |
| Legal source → executable outcome (planned) | Invented rules, lost qualifications, unknown-to-false conversion | Versioned citation and classification, bounded typed rules, independent golden traces |
| Model → browser worker (planned) | Infinite events, memory exhaustion, arbitrary code | Allowlisted interpreter, budgets/cancellation, no uploaded executable expressions |
| Publication → public catalog (planned) | Partial/tampered release, unauthorized disclosure | Verified immutable assets, publication authority, atomic pointer, signing/rotation |
| Private draft → AI provider (optional/planned) | Prompt injection, oversharing, uncontrolled cost | Explicit authorized processing, candidate-only constrained output, no tools, budgets, kill switch |
| App/worker → logs, backup, deployment (planned) | Sensitive logging, lost state, unsafe rollback | Redaction, durable leases, verified restore, isolated migrations and rollback tests |

Trust private server processing explicitly. Do not describe public data or server-readable drafts as private E2EE. Add key/recipient/profile evidence before any protected endpoint-encryption claim.

Foundation residual limits: third-party CI/runtime supply chain and live portfolio ingestion are not independently certified. The six full-product secure-development gate reports are not complete. These honest pending states do not create an external-human-review gate.

## Implemented controls (2026-11-14)

| Boundary | Threat | Implemented control | Evidence |
| --- | --- | --- | --- |
| Browser → author API | Session theft, CSRF, cross-origin mutation | Passkeys (WebAuthn, user verification required); `__Host-` HttpOnly SameSite=Lax cookies; Origin check and double-submit `x-law-machine-csrf` on every mutation; session rotation on sign-in | `tests/browser/authoring.spec.ts`, `tests/unit/authoring-server.test.ts` |
| Author → organization data | Tenant escape, stale role | Membership and role re-read on every request; PostgreSQL forced RLS keyed on a transaction-local `app.organization_id`; app roles NOBYPASSRLS; revocation ends all sessions | `tests/postgres/authoring_roles.sql`, `author_security.sql`, `revocation_guard.sql`, browser cross-org test |
| Publish / invite / revoke | Hijacked session escalates | Publisher role plus passkey reauthentication within 15 minutes; append-only audit log | browser tests; SQL audit immutability |
| Upload → parser | Oversized or active content | 2 MB bound, `.md`/`.txt` only, streamed `readBounded`; parsing in a job; AES-256-GCM at rest | unit tests, `MAX_SOURCE_BYTES` |
| Official refresh | SSRF | HTTPS only; DNS resolved to public addresses only; no redirects; timeout and size bound | `official-fetch.ts` unit tests |
| Draft → AI provider | Prompt injection, oversharing, cost | Off by default; kill switch; one source per request; JSON-schema output; no tools; candidates only; quotes must match verbatim; per-org hourly idempotency | `tests/unit/authoring-server.test.ts` |
| Pack → interpreter | Runaway or arbitrary execution | Data-only rules; event budget clamp (≤100k), same-tick cap, horizon; bounded parameters; worker cancellation | `tests/unit/pack-runtime.test.ts` |
| Release → public | Tampering, partial publish, key compromise | Content-addressed assets re-hashed at publish; ECDSA P-256 signed manifests; trust store with active/retired/revoked; atomic pointer; withdrawal | SDK smoke, explorer integrity test |
| Public API | Abuse, body exhaustion, spoofed IP | Bounded bodies; rate limit keyed on the right-most proxy address; `no-store` on private and author routes | unit tests |
| Saved scenarios | Enumeration, leakage | 256-bit IDs; allowlisted parameters only; hashed delete token; expiry | browser test |
| Web | XSS, framing | CSP restricting scripts, styles and connections to the site itself (`script-src` keeps `'unsafe-inline'` for Next's bootstrap; no `unsafe-eval`), `frame-ancestors 'none'`, nosniff, referrer policy, HSTS | `next.config.ts`, browser runs under CSP |
| Logs, backups | Sensitive logging, data loss | Redacted structured events; encrypted, checksummed backups; isolated restore with replay | `scripts/backup.ts`, CI authoring job |

## Residual risks

- AI-assisted review only. **No independent human audit or penetration test has been performed**, and none is claimed.
- The free hosting tiers have cold starts and shared quotas. The in-process rate limiter is per-instance.
- `LM_SOURCE_KEY` and the release signing key are single environment secrets with no HSM.
- Server-side processing of drafts is authorised processing, not end-to-end encryption (see `security/E2EESA_ADOPTION.md`).
