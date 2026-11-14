-- Reverses 0006 in an ephemeral or restored database. Published content is
-- dropped; production rollback uses the forward-recovery procedure instead.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lm_app, lm_auth;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM lm_app, lm_auth;
REVOKE USAGE ON SCHEMA public FROM lm_app, lm_auth;
DROP POLICY IF EXISTS lm_identities_auth ON lm_author_identities;
DROP POLICY IF EXISTS lm_sessions_auth ON lm_author_sessions;
DROP POLICY IF EXISTS lm_oidc_pending_auth ON lm_oidc_pending_logins;
DROP POLICY IF EXISTS lm_memberships_auth ON lm_memberships;
DROP POLICY IF EXISTS lm_organizations_auth ON lm_organizations;
DROP POLICY IF EXISTS lm_releases_public_read ON lm_releases;
DROP TABLE lm_ai_candidates, lm_run_verifications, lm_saved_scenarios, lm_publication_pointers, lm_release_assets,
  lm_validation_reports, lm_packs, lm_source_objects, lm_invitations, lm_webauthn_challenges, lm_webauthn_credentials, lm_actors;
DROP FUNCTION lm_job_set_result(uuid,uuid,text,bigint,jsonb);
DROP FUNCTION lm_enqueue_job_input(uuid,uuid,uuid,text,text,integer,jsonb,uuid);
ALTER TABLE lm_audit DROP CONSTRAINT lm_audit_action_check;
ALTER TABLE lm_audit ADD CONSTRAINT lm_audit_action_check CHECK (action IN ('created','revised','published','withdrawn'));
DROP INDEX lm_releases_manifest_unique, lm_releases_label_unique;
ALTER TABLE lm_releases DROP COLUMN pack_id, DROP COLUMN label, DROP COLUMN release_id, DROP COLUMN signature, DROP COLUMN catalog,
  DROP COLUMN published_at, DROP COLUMN published_by, DROP COLUMN withdrawn_at, DROP COLUMN note;
ALTER TABLE lm_sources DROP COLUMN name, DROP COLUMN format, DROP COLUMN official_url, DROP COLUMN retrieved_at, DROP COLUMN normalized,
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN supersedes;
DELETE FROM lm_jobs WHERE kind IN ('release-publish','ai-extract','source-refresh');
ALTER TABLE lm_jobs DROP COLUMN input, DROP COLUMN result, DROP COLUMN created_by, DROP COLUMN updated_at;
ALTER TABLE lm_jobs DROP CONSTRAINT lm_jobs_kind_check;
ALTER TABLE lm_jobs ADD CONSTRAINT lm_jobs_kind_check CHECK (kind IN ('source-import','model-compile','release-validate'));
CREATE OR REPLACE FUNCTION lm_enqueue_job(p_org uuid,p_id uuid,p_document uuid,
  p_kind text,p_idempotency text,p_max_attempts integer)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing lm_jobs%ROWTYPE;
BEGIN
 PERFORM lm_assert_job_scope(p_org);
 IF p_kind NOT IN ('source-import','model-compile','release-validate')
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
