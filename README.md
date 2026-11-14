# Law Machine

Follow a hypothetical claim, application, decision or budget through a source-linked model of law. Compare a dated baseline with a proposal, change the circumstances, stress-test the assumptions, and inspect the exact provision behind every step.

**Status (2026-11-14):** the public explorer, the deterministic pack runtime, the headless SDK, passkey-secured authoring with encrypted private sources, durable jobs, signed atomic publication, optional AI candidate extraction, server verification, saved scenarios, backups and the operations runbook are implemented and tested. See [the handoff](docs/HANDOFF.md) for the current state, including what is still blocked.

The three published packs are **fictional** and labelled as such:

- *Meridian claims*, a filing and transfer proposal;
- *Riverbend permits*, a permit-clock amendment;
- *Lakeside library budget*, appropriations with conservation of funds.

The real electronic-filing bill pack stays unavailable until the authentic bill text and dated official baseline are supplied. Nothing here accepts a filing, issues a receipt, computes a real person's deadline, or says a proposal is law.

## Start here

- [Agent instructions](AGENTS.md), [handoff](docs/HANDOFF.md), [architecture](docs/ARCHITECTURE.md), [development plan](docs/DEVELOPMENT_PLAN.md), [PR registry](registry/prs.json)
- [Authoring guide](docs/AUTHORING.md), [HTTP API (OpenAPI)](docs/openapi.yaml), [headless SDK](docs/HEADLESS_SDK.md)
- [Operations runbook](docs/OPERATIONS.md), [threat model](security/THREAT_MODEL.md), [evidence](docs/evidence/)

## Develop and verify

Use Node **24.19.0** and pnpm **11.25.0**:

```sh
pnpm install --frozen-lockfile
pnpm check          # boundaries, lint, types, unit tests, pack golden checks, secret scan, SDK consumer smoke
pnpm build && pnpm start
pnpm test:browser   # Chromium + axe, against the production build
pnpm export:static  # fully static site in dist/static
```

`pnpm dev` runs without any database or credentials (public mode). Authoring needs PostgreSQL and the variables in [OPERATIONS.md](docs/OPERATIONS.md). Ask Bill is a separate product that consumes the headless SDK.
