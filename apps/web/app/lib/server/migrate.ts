import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

/**
 * LM-054 forward migration runner. Applies db/migrations/NNNN_up.sql in order,
 * each in its own transaction, under an advisory lock so concurrent instances
 * cannot race. Applied files are checksummed; a changed historical migration
 * stops the deploy instead of silently diverging.
 */
export type MigrationOptions = {
  readonly url: string;
  readonly appPassword?: string | undefined;
  readonly authPassword?: string | undefined;
  readonly bootstrapInviteDigest?: string | undefined;
  readonly bootstrapOrgSlug?: string | undefined;
  readonly log?: (message: string) => void;
};
function root(): string {
  let dir = resolve(/*turbopackIgnore: true*/ process.cwd());
  for (let i = 0; i < 6; i++) { if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir; dir = dirname(dir); }
  throw Error('Repository root not found');
}
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;

export async function migrate(options: MigrationOptions): Promise<{ applied: string[]; current: number }> {
  const log = options.log ?? (() => undefined);
  const dir = join(root(), 'db', 'migrations');
  const files = readdirSync(dir).filter(f => /^\d{4}_up\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString: options.url, application_name: 'law-machine-migrate', statement_timeout: 120000 });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('law-machine-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS lm_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await client.query('SELECT version, sha256 FROM lm_schema_migrations')).rows.map(r => [Number(r.version), String(r.sha256)]));
    for (const file of files) {
      const version = Number(file.slice(0, 4));
      const text = readFileSync(join(dir, file), 'utf8');
      const digest = sha(text);
      if (done.has(version)) {
        if (done.get(version) !== digest) throw Error('MIGRATION_DRIFT: ' + file + ' changed after it was applied');
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO lm_schema_migrations(version, name, sha256) VALUES ($1,$2,$3)', [version, file, digest]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      applied.push(file);
      log('applied ' + file);
    }
    // Login roles inherit only the narrow group roles; neither can bypass row security.
    for (const [login, group, password] of [['lm_app_login', 'lm_app', options.appPassword], ['lm_auth_login', 'lm_auth', options.authPassword]] as const) {
      if (!password) continue;
      if (!PASSWORD.test(password)) throw Error('ROLE_PASSWORD_FORMAT_INVALID');
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [login])).rowCount;
      await client.query((exists ? 'ALTER' : 'CREATE') + ' ROLE ' + login + " LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '" + password + "'");
      await client.query('GRANT ' + group + ' TO ' + login);
    }
    if (options.bootstrapInviteDigest) await bootstrap(client, options.bootstrapInviteDigest, options.bootstrapOrgSlug ?? 'law-machine', log);
    const current = Number((await client.query('SELECT coalesce(max(version),0) AS v FROM lm_schema_migrations')).rows[0].v);
    return { applied, current };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('law-machine-migrations'))").catch(() => undefined);
    await client.end();
  }
}

/** One-time owner enrollment: a publisher invitation for the first organization, only while it has no publisher. */
async function bootstrap(client: pg.Client, digest: string, slug: string, log: (m: string) => void) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw Error('BOOTSTRAP_CONFIG_INVALID');
  await client.query('BEGIN');
  try {
    await client.query('GRANT lm_auth TO CURRENT_USER');
    await client.query('SET LOCAL ROLE lm_auth');
    let org = (await client.query('SELECT id FROM lm_organizations WHERE slug=$1', [slug])).rows[0]?.id as string | undefined;
    await client.query('RESET ROLE');
    if (!org) {
      org = randomUUID();
      await client.query("SELECT set_config('app.organization_id',$1,true)", [org]);
      await client.query('INSERT INTO lm_organizations(id, slug) VALUES ($1,$2)', [org, slug]);
      log('created organization ' + slug);
    }
    await client.query('SET LOCAL ROLE lm_auth');
    const publishers = (await client.query("SELECT 1 FROM lm_memberships WHERE org_id=$1 AND role='publisher' AND revoked_at IS NULL", [org])).rowCount;
    const existing = (await client.query('SELECT 1 FROM lm_invitations WHERE code_digest=$1', [digest])).rowCount;
    if (!publishers && !existing) {
      await client.query("INSERT INTO lm_invitations(org_id,id,code_digest,role,expires_at) VALUES ($1,$2,$3,'publisher',now()+interval '14 days')", [org, randomUUID(), digest]);
      log('created bootstrap publisher invitation for ' + slug);
    }
    await client.query('RESET ROLE');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
