import type { PackRelease, TrustStore } from '../../../../packages/contracts/src/index.ts';
import type { SignatureCheck } from '../../../../packages/contracts/src/signing.ts';
import type { PackRun } from '../../../../packages/simulation/src/pack-engine.ts';
import type { PackComparison, ParameterIssue, ParameterValues, SandboxEdits, StressRequest, StressResult } from '../../../../packages/simulation/src/pack-analysis.ts';

/** Messages between the explorer and the pack worker. Results carry their generation so stale ones are dropped. */
export type PackRequest =
  | { readonly type: 'load'; readonly generation: number; readonly base: string; readonly packId: string; readonly digest: string; readonly trust: TrustStore }
  | { readonly type: 'run'; readonly generation: number; readonly scenarioId: string; readonly frameworkId: string; readonly params: ParameterValues; readonly edits: SandboxEdits }
  | { readonly type: 'compare'; readonly generation: number; readonly scenarioId: string; readonly params: ParameterValues; readonly edits: SandboxEdits }
  | { readonly type: 'stress'; readonly generation: number; readonly scenarioId: string; readonly params: ParameterValues; readonly request: StressRequest }
  | { readonly type: 'cancel'; readonly generation: number };
export type PreparedSummary = { readonly modified: boolean; readonly modifiedRules: boolean; readonly labels: readonly string[]; readonly issues: readonly ParameterIssue[]; readonly values: ParameterValues };
export type PackResponse =
  | { readonly type: 'loaded'; readonly generation: number; readonly release: PackRelease; readonly manifestDigest: string; readonly releaseId: string; readonly signature: SignatureCheck }
  | { readonly type: 'run'; readonly generation: number; readonly run: PackRun | null; readonly prepared: PreparedSummary }
  | { readonly type: 'compare'; readonly generation: number; readonly comparison: PackComparison | null; readonly prepared: PreparedSummary }
  | { readonly type: 'stress'; readonly generation: number; readonly result: StressResult }
  | { readonly type: 'error'; readonly generation: number; readonly code: string; readonly message: string };
