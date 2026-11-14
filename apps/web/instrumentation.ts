/** Server startup: apply pending migrations (when configured) and start the in-process job runner. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logEvent } = await import('./app/lib/server/telemetry.ts');
  if (process.env.MIGRATION_DATABASE_URL && process.env.LM_MIGRATE_ON_START === '1') {
    try {
      const { migrate } = await import('./app/lib/server/migrate.ts');
      const result = await migrate({ url: process.env.MIGRATION_DATABASE_URL, appPassword: process.env.LM_APP_DB_PASSWORD, authPassword: process.env.LM_AUTH_DB_PASSWORD,
        bootstrapInviteDigest: process.env.LM_BOOTSTRAP_INVITE_DIGEST, bootstrapOrgSlug: process.env.LM_BOOTSTRAP_ORG });
      logEvent('db.migrated', { count: result.applied.length, state: String(result.current) });
    } catch (error) {
      // Public reading keeps working; authoring stays disabled until the database is healthy.
      logEvent('db.migration_failed', { code: String((error as Error)?.message ?? '').replace(/[^A-Z0-9_]/g, '').slice(0, 60) || 'UNKNOWN' }, 'error');
    }
  }
  const { startWorker } = await import('./app/lib/server/worker.ts');
  startWorker();
}
