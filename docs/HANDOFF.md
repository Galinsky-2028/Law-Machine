# Implementation handoff — 2026-11-14 checkpoint

[registry/prs.json](../registry/prs.json) holds unit scope and PR mappings. This dated checkpoint is not a live GitHub status feed, so check the live PRs and checks before acting.

## State

All 60 units' functionality is integrated on `main` through the `lm-complete-integration` PR, except the real-bill content gated by LM-018 (below). The owner directed that units could be combined as long as every functionality was integrated. Per-unit evidence is in `docs/evidence/LM-0XX.md`.

**Runtime and content**
- **Pack runtime (LM-030 engine, LM-055, LM-057, LM-058).**
  - `packages/contracts/src/pack.ts` defines the format.
  - The builder validates exact quotes, coverage and real/fictional labelling, then produces content-addressed, ECDSA-signed releases.
  - The deterministic day-tick interpreter supports duties versus behaviour, three-valued unknowns, breaches, period ends, anchored schedules, effective dates, transfers with conservation and exceptions.
  - Analysis covers comparison, explanation, bounded sandbox parameters, exports verified by recomputation, seeded stress tests and golden checks.
- **Content.** Three fictional packs (119 golden checks) prove domain reuse. The **electronic-filing pack (LM-018/LM-030 content) remains blocked**: no authentic complete bill text or dated official baseline has been supplied. It is listed as unavailable and nothing was reconstructed.

**Public site and integration**
- **Public explorer (LM-031–LM-041).** The catalog, systems map, timeline playback, inspector, comparison, controls and sandbox, stress view, accessible sequence and mobile layout, share links and exports, search and glossary, and the static export. Axe-clean under CSP.
- **SDK (LM-059).** `fetchPackRelease` with required signatures; `pnpm smoke:sdk` proves an external consumer.

**Authoring and operations**
- **Authoring (LM-043–LM-051).**
  - Sign-in and identity: passkeys and invitations, roles, reauthentication, revocation.
  - Sources and editing: encrypted source storage and import with change impact, and a workbench with revision guards.
  - Jobs and publication: fenced-lease jobs, validation into staged releases, private preview, atomic signed publication, withdrawal and rollback.
  - Optional AI candidates (heuristic or Claude) behind a kill switch, and official refresh.
  - Server verification and saved scenarios; the OpenAPI document.
- **Operations (LM-052–LM-054, LM-056, LM-060).** Redacted telemetry and diagnostics, encrypted backup and verified restore, migrations with a down chain and drift detection, security hardening, and the runbook in [OPERATIONS.md](OPERATIONS.md).

## Deployment

- **Render:** web service `law-machine` in the Galinsky 2028 workspace.
- **Neon:** project "Law Machine" (`green-mouse-23144080`) in the campaign organization.

See OPERATIONS.md for variables, verification, rollback and backups. Secrets live only in the Render environment.

## Known limits

- Performance: the phone "compare" interaction measured 215 ms against a 200 ms target (`docs/evidence/performance-web.json`). Engine: 22k events in about 1.0 s.
- Free hosting tiers cold-start. The rate limiter is per instance.
- **No independent human security audit or penetration test has been performed.** All review was AI-performed (see `security/THREAT_MODEL.md`).

## Next actions

1. Supply the authentic electronic-filing bill and dated official baseline. Then author the pack through `/author` or `content/packs/`, attach golden scenarios, and publish.
2. Optionally commission an independent human review.
