import { fetchPackRelease, PackSdkError, type PackSession } from '../../../../packages/sdk/src/index.ts';
import { comparePack } from '../../../../packages/simulation/src/pack-analysis.ts';
import { runPackScenario } from '../../../../packages/simulation/src/pack-engine.ts';
import type { PackRequest, PackResponse, PreparedSummary } from './pack-protocol.ts';

/** Shared request handler used by the worker and by the bounded main-thread fallback. */
export function createPackHandler(post: (message: PackResponse) => void) {
  let session: PackSession | null = null;
  const cancelled = new Set<number>();
  const summary = (p: ReturnType<PackSession['prepare']>): PreparedSummary => ({ modified: p.modified, modifiedRules: p.modifiedRules, labels: p.labels, issues: p.issues, values: p.values });
  const fail = (generation: number, error: unknown) => post({ type: 'error', generation, code: error instanceof PackSdkError ? error.code : error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN', message: error instanceof Error ? error.message : 'Unexpected failure' });
  return async (request: PackRequest): Promise<void> => {
    if (!request || typeof request !== 'object' || typeof request.generation !== 'number') return;
    if (request.type === 'cancel') { cancelled.add(request.generation); return; }
    try {
      if (request.type === 'load') {
        session = await fetchPackRelease(request.base, request.packId, request.digest, { trust: request.trust });
        post({ type: 'loaded', generation: request.generation, release: session.release, manifestDigest: session.manifestDigest, releaseId: session.releaseId, signature: session.signature });
        return;
      }
      if (!session) throw Error('RELEASE_NOT_LOADED');
      if (request.type === 'run') {
        const prepared = session.prepare(request.scenarioId, request.params, request.edits);
        if (prepared.issues.length) { post({ type: 'run', generation: request.generation, run: null, prepared: summary(prepared) }); return; }
        const run = runPackScenario(prepared.release, request.frameworkId, prepared.scenario);
        if (!cancelled.has(request.generation)) post({ type: 'run', generation: request.generation, run, prepared: summary(prepared) });
      } else if (request.type === 'compare') {
        const prepared = session.prepare(request.scenarioId, request.params, request.edits);
        if (prepared.issues.length) { post({ type: 'compare', generation: request.generation, comparison: null, prepared: summary(prepared) }); return; }
        const comparison = await comparePack(prepared.release, session.manifestDigest, prepared.scenario);
        if (!cancelled.has(request.generation)) post({ type: 'compare', generation: request.generation, comparison, prepared: summary(prepared) });
      } else if (request.type === 'stress') {
        const signal = { get cancelled() { return cancelled.has(request.generation); } };
        const result = await session.stress(request.scenarioId, request.request, request.params, signal);
        if (!cancelled.has(request.generation)) post({ type: 'stress', generation: request.generation, result });
      }
    } catch (error) { if (!cancelled.has(request.generation)) fail(request.generation, error); }
  };
}
