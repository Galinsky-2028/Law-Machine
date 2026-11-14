# Authoring guide (LM-043–LM-051)

Authoring turns source documents into a signed, public, executable pack. It needs service mode (see [OPERATIONS.md](OPERATIONS.md)) and an invitation.

1. **Sign in.**
   - Open `/author` and enter your one-time invitation code and display name.
   - Create a passkey. Passwords and email are not used.
   - You can add more passkeys from your account page. Revoking membership ends all of your sessions.
2. **Roles.**
   - *Contributors* and *editors* can create models, upload sources, edit, request validation and review AI candidates.
   - *Publishers* can also publish, withdraw, roll back, invite and revoke. Each of these needs a passkey confirmation within the last 15 minutes.
   - Every check runs on the server, against your current membership.
3. **Create a model.** Pick a pack ID (lowercase and dashes) and a title. Revisions are immutable, and saving with a stale revision is refused (`STALE_REVISION`).
4. **Upload sources** (Sources tab).
   - Accepted files are `.md` or `.txt` up to 2 MB. Bytes are stored AES-256-GCM encrypted and are never public until a release that cites them is published.
   - Parsing runs as a durable job. Re-uploading a new version reports which provisions changed and which rules cite them.
   - An optional official URL lets "Check for update" fetch a newer version. This never republishes automatically: the fetch is HTTPS only, uses public addresses, follows no redirects and is size-bounded.
5. **Model the law** (Rules, Scenarios and JSON tabs).
   - Every rule cites provisions by exact quote. Duties are kept separate from behaviour assumptions, and unknown facts stay unknown.
   - Each source is labelled *real* (official URL and retrieval date required) or *fictional* (the label is shown publicly).
   - The pack format is documented in `packages/contracts/src/pack.ts`. The committed packs under `content/packs/` are complete examples.
6. **AI candidates (optional).**
   - When enabled by the operator, "Suggest rules" sends one private source to the configured provider. This is explicitly authorised server processing, not end-to-end encryption.
   - The provider returns *candidates only*, each with quoted provenance. Quotes that do not appear verbatim in the source are discarded.
   - An editor must accept a candidate, then copy and adapt it into the model. Nothing is published from a candidate.
7. **Validate.**
   - Validation is a job that rebuilds the release from the exact stored source bytes. It checks schemas, quotes, coverage, the compiler, every golden expectation, conservation of accounts and engine limits.
   - Success produces a *staged* release, which you can preview privately (`no-store`, never in the public catalog).
8. **Publish.**
   - A publisher publishes the staged build of the *current* revision. Older validations are refused with `VALIDATION_STALE`.
   - Publication re-verifies every asset digest, signs the manifest with the release key and moves the public pointer atomically. The action is written to the append-only audit log.
9. **Withdraw or roll back.**
   - Withdrawing requires a note. Existing links then show a withdrawn notice instead of the content.
   - "Make current" restores an earlier published release.

The full HTTP surface is in [openapi.yaml](openapi.yaml).
