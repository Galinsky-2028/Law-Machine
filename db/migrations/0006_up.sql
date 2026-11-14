-- LM-043..LM-053: authoring identity, private sources, validation, atomic
-- publication, saved scenarios, verification records and AI candidates.
-- Apply atomically after 0001-0005 on the owner/migration connection.
-- Login roles lm_app and lm_auth are created by the migration runner with
-- out-of-band passwords; this file only creates NOLOGIN group roles if absent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='lm_app') THEN CREATE ROLE lm_app NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='lm_auth') THEN CREATE ROLE lm_auth NOLOGIN NOBYPASSRLS; END IF;
END $$;

-- Jobs: additional durable kinds and bounded input/result payloads.
ALTER TABLE lm_jobs DROP CONSTRAINT lm_jobs_kind_check;
ALTER TABLE lm_jobs ADD CONSTRAINT lm_jobs_kind_check CHECK (kind IN
  ('source-import','model-compile','release-validate','release-publish','ai-extract','source-refresh'));
ALTER TABLE lm_jobs ADD COLUMN input jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=16384);
ALTER TABLE lm_jobs ADD COLUMN result jsonb
  CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=262144));
ALTER TABLE lm_jobs ADD COLUMN created_by uuid;
ALTER TABLE lm_jobs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION lm_enqueue_job(p_org uuid,p_id uuid,p_document uuid,
  p_kind text,p_idempotency text,p_max_attempts integer)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing lm_jobs%ROWTYPE;
BEGIN
 PERFORM lm_assert_job_scope(p_org);
 IF p_kind NOT IN ('source-import','model-compile','release-validate','release-publish','ai-extract','source-refresh')
   OR length(p_idempotency) NOT BETWEEN 1 AND 128 OR p_max_attempts NOT BETWEEN 1 AND 10
 THEN RAISE EXCEPTION 'LM_JOB_INVALID'; END IF;
 INSERT INTO lm_jobs(org_id,id,document_id,kind,idempotency_key,max_attempts)
 VALUES(p_org,p_id,p_document,p_kind,p_idempotency,p_max_attempts)
 ON CONFLICT (org_id,idempotency_key) DO NOTHING;
 SELECT * INTO existing FROM lm_jobs WHERE org_id=p_org AND idempotency_key=p_idempotency;
 IF NOT FOUND OR existing.document_id IS DISTINCT FROM p_document OR
    existing.kind IS DISTINCT FROM p_kind OR existing.max_attempts IS DISTINCT FROM p_max_attempts
 THEN RAISE EXCEPTION 'LM_JOB_IDEMPOTENCY_CONFLICT'; END IF;
 RETURN existing.id;
END; $$;

-- Idempotent enqueue with input: a repeated key must carry identical input.
CREATE FUNCTION lm_enqueue_job_input(p_org uuid,p_id uuid,p_document uuid,p_kind text,
  p_idempotency text,p_max_attempts integer,p_input jsonb,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE job uuid; current_input jsonb;
BEGIN
 IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>16384
 THEN RAISE EXCEPTION 'LM_JOB_INVALID'; END IF;
 job := lm_enqueue_job(p_org,p_id,p_document,p_kind,p_idempotency,p_max_attempts);
 SELECT input INTO current_input FROM lm_jobs WHERE org_id=p_org AND id=job;
 IF job=p_id AND current_input='{}'::jsonb THEN
   UPDATE lm_jobs SET input=p_input,created_by=p_actor WHERE org_id=p_org AND id=job AND state='queued' AND attempts=0;
 ELSIF current_input IS DISTINCT FROM p_input THEN
   RAISE EXCEPTION 'LM_JOB_IDEMPOTENCY_CONFLICT';
 END IF;
 RETURN job;
END; $$;

-- Results can only be written by the current fenced lease holder.
CREATE FUNCTION lm_job_set_result(p_org uuid,p_id uuid,p_worker text,p_fence bigint,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM lm_assert_job_scope(p_org);
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>262144 THEN RETURN false; END IF;
 UPDATE lm_jobs SET result=p_result,updated_at=now()
  WHERE org_id=p_org AND id=p_id AND state='running' AND fence=p_fence AND worker_id=p_worker AND lease_until>clock_timestamp();
 RETURN FOUND;
END; $$;

-- Identity: actors, passkeys, one-time challenges, invitations.
CREATE TABLE lm_actors (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lm_webauthn_credentials (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1366),
  actor_id uuid NOT NULL REFERENCES lm_actors(id),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 32 AND 2048),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}' CHECK (cardinality(transports) <= 8),
  label text NOT NULL DEFAULT 'Passkey' CHECK (length(label) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX lm_webauthn_by_actor ON lm_webauthn_credentials(actor_id);
CREATE TABLE lm_webauthn_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]+$' AND length(challenge) BETWEEN 16 AND 512),
  purpose text NOT NULL CHECK (purpose IN ('register','authenticate')),
  browser_digest text NOT NULL CHECK (browser_digest ~ '^[a-f0-9]{64}$'),
  actor_id uuid,
  invitation_digest text CHECK (invitation_digest IS NULL OR invitation_digest ~ '^[a-f0-9]{64}$'),
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '10 minutes')
);
CREATE INDEX lm_webauthn_challenge_expiry ON lm_webauthn_challenges(expires_at);
CREATE TABLE lm_invitations (
  org_id uuid NOT NULL REFERENCES lm_organizations(id),
  id uuid NOT NULL,
  code_digest text NOT NULL UNIQUE CHECK (code_digest ~ '^[a-f0-9]{64}$'),
  role text NOT NULL CHECK (role IN ('contributor','editor','publisher')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at <= created_at + INTERVAL '14 days'),
  used_at timestamptz,
  used_by uuid,
  revoked_at timestamptz,
  PRIMARY KEY (org_id, id)
);

-- Private sources: metadata on lm_sources, AES-256-GCM envelopes in lm_source_objects.
ALTER TABLE lm_sources ADD COLUMN name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200);
ALTER TABLE lm_sources ADD COLUMN format text CHECK (format IS NULL OR format IN ('text','markdown','docx','xml','pdf'));
ALTER TABLE lm_sources ADD COLUMN official_url text CHECK (official_url IS NULL OR official_url ~ '^https://');
ALTER TABLE lm_sources ADD COLUMN retrieved_at timestamptz;
ALTER TABLE lm_sources ADD COLUMN normalized jsonb CHECK (normalized IS NULL OR octet_length(normalized::text) <= 6000000);
ALTER TABLE lm_sources ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE lm_sources ADD COLUMN created_by uuid;
ALTER TABLE lm_sources ADD COLUMN supersedes uuid;
CREATE TABLE lm_source_objects (
  org_id uuid NOT NULL,
  source_id uuid NOT NULL,
  envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 34 AND 16000000),
  PRIMARY KEY (org_id, source_id),
  FOREIGN KEY (org_id, source_id) REFERENCES lm_sources(org_id, id)
);

-- Authoring packs, validation reports and publication.
CREATE TABLE lm_packs (
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  pack_id text NOT NULL UNIQUE CHECK (pack_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  PRIMARY KEY (org_id, document_id),
  FOREIGN KEY (org_id, document_id) REFERENCES lm_documents(org_id, id)
);
CREATE TABLE lm_validation_reports (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision bigint NOT NULL,
  valid boolean NOT NULL,
  manifest_digest text CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object' AND octet_length(report::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, document_id, revision) REFERENCES lm_revisions(org_id, document_id, revision)
);
CREATE INDEX lm_validation_by_revision ON lm_validation_reports(org_id, document_id, revision, created_at DESC);
ALTER TABLE lm_releases ADD COLUMN pack_id text CHECK (pack_id IS NULL OR pack_id ~ '^[a-z0-9][a-z0-9-]{0,79}$');
ALTER TABLE lm_releases ADD COLUMN label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60);
ALTER TABLE lm_releases ADD COLUMN release_id text;
ALTER TABLE lm_releases ADD COLUMN signature jsonb;
ALTER TABLE lm_releases ADD COLUMN catalog jsonb;
ALTER TABLE lm_releases ADD COLUMN published_at timestamptz;
ALTER TABLE lm_releases ADD COLUMN published_by uuid;
ALTER TABLE lm_releases ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE lm_releases ADD COLUMN note text CHECK (note IS NULL OR length(note) <= 500);
CREATE UNIQUE INDEX lm_releases_manifest_unique ON lm_releases(manifest_digest);
CREATE UNIQUE INDEX lm_releases_label_unique ON lm_releases(pack_id, label) WHERE pack_id IS NOT NULL AND status <> 'staged';
CREATE TABLE lm_release_assets (
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  path text NOT NULL CHECK (path ~ '^assets/[a-f0-9]{64}\.[a-z0-9]{1,8}$' OR path = 'manifest.json'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 8000000),
  PRIMARY KEY (manifest_digest, path)
);
CREATE TABLE lm_publication_pointers (
  pack_id text PRIMARY KEY CHECK (pack_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  org_id uuid NOT NULL,
  release_uuid uuid NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  FOREIGN KEY (org_id, release_uuid) REFERENCES lm_releases(org_id, id)
);
ALTER TABLE lm_audit DROP CONSTRAINT lm_audit_action_check;
ALTER TABLE lm_audit ADD CONSTRAINT lm_audit_action_check CHECK (action IN
  ('created','revised','published','withdrawn','validated','pointer-restored','imported'));

-- Anonymous explicit saves and server verification records (no tenant, unguessable IDs).
CREATE TABLE lm_saved_scenarios (
  id_digest text PRIMARY KEY CHECK (id_digest ~ '^[a-f0-9]{64}$'),
  delete_digest text NOT NULL CHECK (delete_digest ~ '^[a-f0-9]{64}$'),
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  scenario_id text NOT NULL CHECK (scenario_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  framework_id text NOT NULL CHECK (framework_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object' AND octet_length(parameters::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '400 days'),
  deleted_at timestamptz
);
CREATE INDEX lm_saved_expiry ON lm_saved_scenarios(expires_at);
CREATE TABLE lm_run_verifications (
  run_id text NOT NULL CHECK (run_id ~ '^[a-f0-9]{64}$'),
  trace_digest text NOT NULL CHECK (trace_digest ~ '^[a-f0-9]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  pack_id text NOT NULL,
  verified_at timestamptz NOT NULL,
  verifier_key_id text,
  PRIMARY KEY (run_id, trace_digest)
);

-- Optional AI extraction candidates: never executable until an editor accepts them.
CREATE TABLE lm_ai_candidates (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  job_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,40}$'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  output_digest text NOT NULL CHECK (output_digest ~ '^[a-f0-9]{64}$'),
  candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate)='object' AND octet_length(candidate::text) <= 32000),
  disposition text NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending','accepted','rejected')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, document_id) REFERENCES lm_documents(org_id, id)
);

-- Row security. Tenant tables follow the existing app.organization_id rule.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['lm_actors','lm_webauthn_credentials','lm_webauthn_challenges','lm_invitations','lm_source_objects','lm_packs',
    'lm_validation_reports','lm_release_assets','lm_publication_pointers','lm_saved_scenarios','lm_run_verifications','lm_ai_candidates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['lm_invitations','lm_source_objects','lm_packs','lm_validation_reports','lm_ai_candidates'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I TO lm_app USING (org_id::text = current_setting(''app.organization_id'',true)) WITH CHECK (org_id::text = current_setting(''app.organization_id'',true))', t || '_tenant', t);
  END LOOP;
END $$;
-- Identity service: narrow, explicit access only for lm_auth.
CREATE POLICY lm_actors_auth ON lm_actors TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_actors_app_read ON lm_actors FOR SELECT TO lm_app USING (EXISTS (
  SELECT 1 FROM lm_memberships m WHERE m.actor_id = lm_actors.id AND m.org_id::text = current_setting('app.organization_id',true)));
CREATE POLICY lm_webauthn_auth ON lm_webauthn_credentials TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_challenges_auth ON lm_webauthn_challenges TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_invitations_auth ON lm_invitations TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_identities_auth ON lm_author_identities TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_sessions_auth ON lm_author_sessions TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_oidc_pending_auth ON lm_oidc_pending_logins TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_memberships_auth ON lm_memberships TO lm_auth USING (true) WITH CHECK (true);
CREATE POLICY lm_organizations_auth ON lm_organizations FOR SELECT TO lm_auth USING (true);
-- Public reads: only published releases and their assets, never staged or withdrawn content.
CREATE POLICY lm_releases_public_read ON lm_releases FOR SELECT TO lm_app USING (status IN ('published','withdrawn'));
CREATE POLICY lm_release_assets_public_read ON lm_release_assets FOR SELECT TO lm_app USING (EXISTS (
  SELECT 1 FROM lm_releases r WHERE r.manifest_digest = lm_release_assets.manifest_digest AND r.status = 'published'));
CREATE POLICY lm_release_assets_tenant_write ON lm_release_assets FOR INSERT TO lm_app WITH CHECK (current_setting('app.organization_id',true) IS NOT NULL AND current_setting('app.organization_id',true) <> '');
CREATE POLICY lm_release_assets_tenant_read ON lm_release_assets FOR SELECT TO lm_app USING (EXISTS (
  SELECT 1 FROM lm_releases r WHERE r.manifest_digest = lm_release_assets.manifest_digest AND r.org_id::text = current_setting('app.organization_id',true)));
CREATE POLICY lm_pointers_public_read ON lm_publication_pointers FOR SELECT TO lm_app USING (true);
CREATE POLICY lm_pointers_tenant_write ON lm_publication_pointers FOR INSERT TO lm_app WITH CHECK (org_id::text = current_setting('app.organization_id',true));
CREATE POLICY lm_pointers_tenant_update ON lm_publication_pointers FOR UPDATE TO lm_app
  USING (org_id::text = current_setting('app.organization_id',true)) WITH CHECK (org_id::text = current_setting('app.organization_id',true));
CREATE POLICY lm_saved_app ON lm_saved_scenarios TO lm_app USING (true) WITH CHECK (true);
CREATE POLICY lm_verifications_app ON lm_run_verifications TO lm_app USING (true) WITH CHECK (true);

-- Least-privilege grants. No role may delete history; audit is append-only.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lm_app, lm_auth;
GRANT USAGE ON SCHEMA public TO lm_app, lm_auth;
GRANT SELECT ON lm_organizations TO lm_app, lm_auth;
GRANT SELECT, INSERT, UPDATE ON lm_memberships TO lm_app, lm_auth;
GRANT SELECT, INSERT, UPDATE ON lm_documents, lm_sources, lm_jobs, lm_releases, lm_invitations, lm_ai_candidates TO lm_app;
GRANT SELECT, INSERT ON lm_revisions, lm_audit, lm_source_objects, lm_packs, lm_validation_reports, lm_release_assets, lm_run_verifications TO lm_app;
GRANT SELECT, INSERT, UPDATE ON lm_publication_pointers TO lm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lm_saved_scenarios TO lm_app;
GRANT SELECT ON lm_actors TO lm_app;
GRANT SELECT, INSERT, UPDATE ON lm_actors, lm_author_identities, lm_author_sessions, lm_webauthn_credentials, lm_invitations TO lm_auth;
GRANT SELECT, INSERT, DELETE ON lm_webauthn_challenges, lm_oidc_pending_logins TO lm_auth;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO lm_app;
GRANT EXECUTE ON FUNCTION lm_consume_oidc_pending(text,text) TO lm_auth;
