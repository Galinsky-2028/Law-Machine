import type { AuthorContext } from '../author-auth.ts';
import { aiStatus } from './ai.ts';
import { database } from './db.ts';
import { counterSnapshot } from './telemetry.ts';

/** LM-052 operating diagnostics for an organization. Counts and codes only: no content or facts. */
export async function diagnostics(ctx: AuthorContext) {
  const db = database();
  const jobs = db ? await db.inOrganization(ctx.organizationId, async tx => ({
    byState: (await tx.query('SELECT kind, state, count(*)::int AS n FROM lm_jobs GROUP BY kind, state ORDER BY kind, state')).rows,
    oldestQueuedSeconds: Number((await tx.query("SELECT coalesce(extract(epoch FROM now()-min(available_at)),0)::int AS s FROM lm_jobs WHERE state='queued'")).rows[0]!.s),
    recentFailures: (await tx.query("SELECT id, kind, last_error_code, attempts, updated_at FROM lm_jobs WHERE state='failed' OR last_error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 20")).rows,
    validations: (await tx.query('SELECT valid, count(*)::int AS n FROM lm_validation_reports GROUP BY valid')).rows
  })) : null;
  return {
    service: { status: 'ok', commit: (process.env.RENDER_GIT_COMMIT ?? 'unknown').slice(0, 12), ...counterSnapshot() },
    database: db ? 'ok' : 'not-configured', worker: process.env.LM_WORKER === 'off' ? 'separate-process' : 'in-process', jobs,
    providers: { ai: aiStatus(), releaseSigning: process.env.LM_RELEASE_SIGNING_KEY ? 'configured' : 'not configured (releases publish unsigned)', sourceEncryption: process.env.LM_SOURCE_KEY ? 'configured' : 'missing (imports disabled)' },
    note: 'Provider failures never affect already published models, which are served as static or database-backed immutable files.'
  };
}
