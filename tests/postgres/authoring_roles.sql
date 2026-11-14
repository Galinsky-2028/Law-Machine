-- LM-043..LM-053 role and row-security regression tests (run as a superuser after 0001-0006).
\set ON_ERROR_STOP 1
BEGIN;
INSERT INTO lm_organizations(id, slug) VALUES ('7a110000-0000-4000-8000-0000000000a1','lm-test-org-a'),('7a110000-0000-4000-8000-0000000000b2','lm-test-org-b');
INSERT INTO lm_memberships(org_id, actor_id, role) VALUES ('7a110000-0000-4000-8000-0000000000a1','7a110000-0000-4000-8000-0000000000c3','publisher');
INSERT INTO lm_actors(id, display_name) VALUES ('7a110000-0000-4000-8000-0000000000c3','A');
INSERT INTO lm_documents(org_id,id,revision) VALUES ('7a110000-0000-4000-8000-0000000000a1','d0000000-0000-4000-8000-000000000001',1),('7a110000-0000-4000-8000-0000000000b2','d0000000-0000-4000-8000-000000000002',1);
INSERT INTO lm_revisions(org_id,document_id,revision,payload,content_digest,actor_id) VALUES
 ('7a110000-0000-4000-8000-0000000000a1','d0000000-0000-4000-8000-000000000001',1,'{}',repeat('a',64),'7a110000-0000-4000-8000-0000000000c3'),
 ('7a110000-0000-4000-8000-0000000000b2','d0000000-0000-4000-8000-000000000002',1,'{}',repeat('a',64),'7a110000-0000-4000-8000-0000000000c3');
INSERT INTO lm_packs VALUES ('7a110000-0000-4000-8000-0000000000a1','d0000000-0000-4000-8000-000000000001','lm-test-pack-a'),('7a110000-0000-4000-8000-0000000000b2','d0000000-0000-4000-8000-000000000002','lm-test-pack-b');
INSERT INTO lm_audit(org_id,document_id,revision,actor_id,action) VALUES ('7a110000-0000-4000-8000-0000000000a1','d0000000-0000-4000-8000-000000000001',1,'7a110000-0000-4000-8000-0000000000c3','created');
INSERT INTO lm_releases(org_id,id,document_id,revision,manifest_digest,status,pack_id,label) VALUES
 ('7a110000-0000-4000-8000-0000000000a1','e0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',1,repeat('1',64),'staged','lm-test-pack-a','1'),
 ('7a110000-0000-4000-8000-0000000000b2','e0000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000002',1,repeat('2',64),'published','lm-test-pack-b','1');
INSERT INTO lm_release_assets VALUES (repeat('1',64),'manifest.json','staged'),(repeat('2',64),'manifest.json','published');
INSERT INTO lm_author_identities(provider,subject,actor_id) VALUES ('webauthn','7a110000-0000-4000-8000-0000000000c3','7a110000-0000-4000-8000-0000000000c3');
COMMIT;

-- App role without tenant context sees no tenant rows, only published public content.
SET ROLE lm_app;
DO $$ BEGIN
  IF (SELECT count(*) FROM lm_packs) <> 0 THEN RAISE EXCEPTION 'packs leaked without tenant'; END IF;
  IF (SELECT count(*) FROM lm_release_assets) <> 1 THEN RAISE EXCEPTION 'staged asset publicly readable'; END IF;
  IF (SELECT count(*) FROM lm_releases) <> 1 THEN RAISE EXCEPTION 'staged release publicly readable'; END IF;
END $$;
-- Identity tables are invisible to the app role.
DO $$ BEGIN PERFORM 1 FROM lm_author_sessions; RAISE EXCEPTION 'app read sessions'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM 1 FROM lm_webauthn_credentials; RAISE EXCEPTION 'app read credentials'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
-- Tenant scope: org A sees only its rows.
BEGIN;
SELECT set_config('app.organization_id','7a110000-0000-4000-8000-0000000000a1',true);
DO $$ BEGIN
  IF (SELECT array_agg(pack_id) FROM lm_packs) <> ARRAY['lm-test-pack-a'] THEN RAISE EXCEPTION 'cross-tenant pack visible'; END IF;
  IF (SELECT count(*) FROM lm_release_assets WHERE manifest_digest=repeat('1',64)) <> 1 THEN RAISE EXCEPTION 'tenant cannot read own staged asset'; END IF;
END $$;
-- Writing another tenant's pack is rejected by WITH CHECK.
DO $$ BEGIN INSERT INTO lm_packs VALUES ('7a110000-0000-4000-8000-0000000000b2','d0000000-0000-4000-8000-000000000002','lm-test-pack-x'); RAISE EXCEPTION 'cross-tenant insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
COMMIT;
-- Audit history is append-only for the application.
BEGIN;
SELECT set_config('app.organization_id','7a110000-0000-4000-8000-0000000000a1',true);
DO $$ BEGIN UPDATE lm_audit SET action='withdrawn'; RAISE EXCEPTION 'audit update allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN DELETE FROM lm_audit; RAISE EXCEPTION 'audit delete allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN DELETE FROM lm_revisions; RAISE EXCEPTION 'revision delete allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
COMMIT;
-- Job results need the current fenced lease.
BEGIN;
SELECT set_config('app.organization_id','7a110000-0000-4000-8000-0000000000a1',true);
SELECT lm_enqueue_job_input('7a110000-0000-4000-8000-0000000000a1','f0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','release-validate','validate:1',3,'{"revision":1}','7a110000-0000-4000-8000-0000000000c3');
DO $$ BEGIN
  IF lm_job_set_result('7a110000-0000-4000-8000-0000000000a1','f0000000-0000-4000-8000-000000000001','w1',1,'{"x":1}') THEN RAISE EXCEPTION 'result written without lease'; END IF;
END $$;
DO $$ BEGIN PERFORM lm_enqueue_job_input('7a110000-0000-4000-8000-0000000000a1','f0000000-0000-4000-8000-000000000009','d0000000-0000-4000-8000-000000000001','release-validate','validate:1',3,'{"revision":2}',NULL);
  RAISE EXCEPTION 'idempotency key reused with different input'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'LM_JOB_IDEMPOTENCY_CONFLICT' THEN RAISE; END IF; END $$;
COMMIT;
RESET ROLE;

-- Auth role reads identity data but never editorial content or private sources.
SET ROLE lm_auth;
DO $$ BEGIN
  IF (SELECT count(*) FROM lm_author_identities WHERE subject='7a110000-0000-4000-8000-0000000000c3') <> 1 THEN RAISE EXCEPTION 'auth cannot read identities'; END IF;
END $$;
DO $$ BEGIN PERFORM 1 FROM lm_documents; RAISE EXCEPTION 'auth read documents'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM 1 FROM lm_source_objects; RAISE EXCEPTION 'auth read sources'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
-- Neither application role can bypass row security.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('lm_app','lm_auth') AND (rolbypassrls OR rolsuper)) THEN RAISE EXCEPTION 'role bypasses RLS'; END IF; END $$;
SELECT 'authoring role and row-security tests passed' AS result;
