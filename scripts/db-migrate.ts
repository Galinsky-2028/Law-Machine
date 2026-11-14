import { migrate } from '../apps/web/app/lib/server/migrate.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw Error('Set MIGRATION_DATABASE_URL (owner connection) to run migrations');
const result = await migrate({ url, appPassword: process.env.LM_APP_DB_PASSWORD, authPassword: process.env.LM_AUTH_DB_PASSWORD,
  bootstrapInviteDigest: process.env.LM_BOOTSTRAP_INVITE_DIGEST, bootstrapOrgSlug: process.env.LM_BOOTSTRAP_ORG, log: m => console.log(m) });
console.log('schema version ' + result.current + (result.applied.length ? ' (applied ' + result.applied.join(', ') + ')' : ' (up to date)'));
