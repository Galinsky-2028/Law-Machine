import { readCatalog } from '../../lib/server/releases.ts';
import { database } from '../../lib/server/db.ts';

/**
 * Liveness plus dependency status. Public reading only needs the static
 * releases, so an absent or failing database never makes this unhealthy;
 * it is reported separately so authoring readiness is visible.
 */
export async function GET() {
  let releases = 0;
  try { releases = readCatalog().packs.length; } catch { releases = 0; }
  const db = database();
  let databaseStatus: 'not-configured' | 'ok' | 'unavailable' = 'not-configured';
  if (db) { try { await db.query('SELECT 1'); databaseStatus = 'ok'; } catch { databaseStatus = 'unavailable'; } }
  return Response.json({
    status: releases > 0 ? 'ok' : 'degraded', application: 'law-machine', simulationAvailable: releases > 0, publishedPacks: releases,
    filingsAccepted: false, database: databaseStatus, authoring: databaseStatus === 'ok' && !!process.env.LM_AUTH_MODE ? 'enabled' : 'disabled',
    commit: (process.env.RENDER_GIT_COMMIT ?? process.env.LM_COMMIT ?? 'unknown').slice(0, 40)
  }, { status: releases > 0 ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
