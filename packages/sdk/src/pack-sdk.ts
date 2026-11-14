import { canonicalDigest, canonicalJSON, sha256Hex, verifyRelease } from '../../contracts/src/integrity.ts';
import type { SourceRef } from '../../contracts/src/model.ts';
import { PACK_ENGINE_VERSION, type FocusTarget, type GlossaryEntry, type PackProvision, type PackRelease } from '../../contracts/src/pack.ts';
import { verifyReleaseSignature, type ReleaseSignature, type SignatureCheck, type TrustStore } from '../../contracts/src/signing.ts';
import { buildSearchDocs, resolveFocus, search, type ResolvedFocus, type SearchHit } from '../../presentation/src/projection.ts';
import {
  comparePack, explainEvent, exportRun, prepareScenario, resolveExcerpt, stressScenario, verifyRunExport,
  type ExplainedEvent, type PackComparison, type ParameterValues, type PreparedScenario, type RunExport, type SandboxEdits, type StressRequest, type StressResult
} from '../../simulation/src/pack-analysis.ts';
import { runPackScenario, type PackRun } from '../../simulation/src/pack-engine.ts';

/**
 * LM-059 shared SDK. A consumer (for example a future Ask Bill application)
 * loads a signed public release, resolves citations, runs scenarios and asks
 * for semantic focus targets without importing the Law Machine UI. Nothing
 * here fetches unless the caller supplies a fetch function, and nothing here
 * can reach private authoring data.
 */
export type PackSdkErrorCode = 'MANIFEST_INVALID' | 'INTEGRITY_FAILED' | 'INCOMPATIBLE_ENGINE' | 'INCOMPATIBLE_SCHEMA' | 'BUNDLE_INVALID' | 'FETCH_FAILED' | 'NOT_FOUND' | 'AMBIGUOUS_CITATION' | 'SIGNATURE_REQUIRED';
export class PackSdkError extends Error { constructor(readonly code: PackSdkErrorCode, message: string) { super(message); } }
export type PackManifestFile = { readonly schemaVersion: '1.0.0'; readonly format: 'law-machine-pack-v1'; readonly packId: string; readonly label: string; readonly releaseId: string; readonly engineVersion: string; readonly bundlePath: string; readonly sourceDigest: string; readonly assets: readonly { readonly path: string; readonly digest: string }[] };
export type LoadPackInput = {
  readonly manifestBytes: Uint8Array;
  /** Independently trusted digest (from the catalog pointer or a signature). */
  readonly expectedManifestDigest: string;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly signature?: ReleaseSignature | null;
  readonly trust?: TrustStore | null;
  readonly requireSignature?: boolean;
};
export type CitationResult = { readonly status: 'resolved' | 'stale' | 'unavailable' | 'ambiguous'; readonly citation: string | null; readonly quote: string | null; readonly text: string | null; readonly documentTitle: string | null; readonly versionId: string | null; readonly provisionId: string | null };

export class PackSession {
  readonly engineVersion = PACK_ENGINE_VERSION;
  private searchIndex: ReturnType<typeof buildSearchDocs> | null = null;
  constructor(readonly release: PackRelease, readonly manifest: PackManifestFile, readonly manifestDigest: string, readonly signature: SignatureCheck) {}
  get releaseId(): string { return this.manifest.releaseId; }
  listDocuments() { return this.release.documents.map(d => ({ sourceId: d.sourceId, versionId: d.versionId, title: d.title, kind: d.kind, sourceDigest: d.sourceDigest, provisionCount: d.provisions.length })); }
  listProvisions(versionId?: string): readonly PackProvision[] {
    const docs = versionId ? this.release.documents.filter(d => d.versionId === versionId) : this.release.documents;
    return docs.flatMap(d => d.provisions);
  }
  /** Resolve a pinned anchor, or a displayed citation within one version. Never guesses across versions. */
  resolveCitation(input: SourceRef | { readonly versionId: string; readonly citation: string }): CitationResult {
    if ('quote' in input) {
      const x = resolveExcerpt(this.release, input);
      if (!x.text) return { status: 'unavailable', citation: null, quote: null, text: null, documentTitle: null, versionId: input.versionId, provisionId: input.provisionId };
      return { status: x.stale ? 'stale' : 'resolved', citation: x.citation, quote: x.stale ? null : x.quote, text: x.text, documentTitle: x.documentTitle, versionId: x.versionId, provisionId: x.provisionId };
    }
    const doc = this.release.documents.find(d => d.versionId === input.versionId);
    const matches = doc?.provisions.filter(p => p.citation === input.citation || p.path === input.citation) ?? [];
    if (matches.length > 1) return { status: 'ambiguous', citation: input.citation, quote: null, text: null, documentTitle: doc!.title, versionId: input.versionId, provisionId: null };
    const p = matches[0];
    return p ? { status: 'resolved', citation: p.citation, quote: null, text: p.text, documentTitle: doc!.title, versionId: p.versionId, provisionId: p.id } : { status: 'unavailable', citation: input.citation, quote: null, text: null, documentTitle: doc?.title ?? null, versionId: input.versionId, provisionId: null };
  }
  getGlossaryEntry(idOrTerm: string): GlossaryEntry<SourceRef> | null {
    const key = String(idOrTerm).toLowerCase();
    return this.release.glossary.find(g => g.id === key || g.term.toLowerCase() === key || g.aliases.some(a => a.toLowerCase() === key)) ?? null;
  }
  search(query: string, base = '/packs/' + this.release.packId): SearchHit[] {
    this.searchIndex ??= buildSearchDocs(this.release, base);
    return search(this.searchIndex, query);
  }
  prepare(scenarioId: string, params: ParameterValues = {}, edits: SandboxEdits = {}): PreparedScenario { return prepareScenario(this.release, scenarioId, params, edits); }
  runScenario(scenarioId: string, options: { readonly frameworkId?: string; readonly params?: ParameterValues } = {}): { readonly run: PackRun; readonly prepared: PreparedScenario } {
    const prepared = this.prepare(scenarioId, options.params ?? {});
    if (prepared.issues.length) throw new PackSdkError('BUNDLE_INVALID', prepared.issues.map(i => i.message).join(' '));
    const frameworkId = options.frameworkId ?? (this.release.frameworks.find(f => f.role === 'proposal') ?? this.release.frameworks[0]!).id;
    return { run: runPackScenario(prepared.release, frameworkId, prepared.scenario), prepared };
  }
  compare(scenarioId: string, params: ParameterValues = {}): Promise<PackComparison> {
    const prepared = this.prepare(scenarioId, params);
    return comparePack(prepared.release, this.manifestDigest, prepared.scenario);
  }
  getTraceExplanation(run: PackRun, eventId: string): ExplainedEvent { return explainEvent(this.release, run, eventId); }
  getSceneFocusTarget(target: FocusTarget, run: PackRun | null = null): ResolvedFocus { return resolveFocus(this.release, run, target); }
  stress(scenarioId: string, request: StressRequest, params: ParameterValues = {}, signal?: { readonly cancelled: boolean }): Promise<StressResult> {
    const prepared = this.prepare(scenarioId, params);
    return stressScenario(prepared.release, this.manifestDigest, prepared.scenario, request, signal);
  }
  exportRun(prepared: PreparedScenario, run: PackRun): Promise<RunExport> { return exportRun(this.release, this.manifest.releaseId, this.manifestDigest, prepared, run); }
  verifyRun(claim: RunExport) { return verifyRunExport(this.release, this.manifestDigest, claim); }
}

/** Verify manifest digest, every content-addressed asset, the engine and schema, then the optional signature. */
export async function loadPackRelease(input: LoadPackInput): Promise<PackSession> {
  let manifest: PackManifestFile;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.manifestBytes)) as PackManifestFile; }
  catch { throw new PackSdkError('MANIFEST_INVALID', 'Manifest is not JSON'); }
  if (!manifest || manifest.format !== 'law-machine-pack-v1' || typeof manifest.bundlePath !== 'string' || !Array.isArray(manifest.assets)) throw new PackSdkError('MANIFEST_INVALID', 'Not a Law Machine pack manifest');
  if (manifest.schemaVersion !== '1.0.0') throw new PackSdkError('INCOMPATIBLE_SCHEMA', 'Unsupported schema ' + String(manifest.schemaVersion));
  if (manifest.engineVersion !== PACK_ENGINE_VERSION) throw new PackSdkError('INCOMPATIBLE_ENGINE', 'This SDK runs engine ' + PACK_ENGINE_VERSION + ', release requires ' + manifest.engineVersion);
  const primary = manifest.assets.find(a => a.digest === manifest.sourceDigest);
  const integrity = await verifyRelease(manifest, input.expectedManifestDigest, primary ? input.assets.get(primary.path)! : new Uint8Array(), input.assets);
  if (!integrity.valid) throw new PackSdkError('INTEGRITY_FAILED', 'Release failed verification: ' + integrity.diagnostics.map(d => d.code).join(', '));
  if (canonicalJSON(JSON.parse(new TextDecoder().decode(input.manifestBytes))) !== canonicalJSON(manifest)) throw new PackSdkError('MANIFEST_INVALID', 'Manifest changed during parsing');
  const bundleBytes = input.assets.get(manifest.bundlePath);
  if (!bundleBytes) throw new PackSdkError('INTEGRITY_FAILED', 'Bundle asset missing');
  let release: PackRelease;
  try { release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes)) as PackRelease; }
  catch { throw new PackSdkError('BUNDLE_INVALID', 'Bundle is not JSON'); }
  if (release.packId !== manifest.packId || release.engineVersion !== manifest.engineVersion || release.schemaVersion !== '1.0.0') throw new PackSdkError('BUNDLE_INVALID', 'Bundle does not match its manifest');
  // Every source document's original bytes must be one of the verified assets.
  for (const d of release.documents) if (await sha256Hex(input.assets.get(d.assetPath) ?? new Uint8Array([1])) !== d.sourceDigest) throw new PackSdkError('INTEGRITY_FAILED', 'Source bytes for ' + d.title + ' do not match');
  const signature = input.trust ? await verifyReleaseSignature(input.trust, integrity.manifestDigest!, input.signature) : { valid: false, reason: 'UNSIGNED' as const, keyId: null };
  if (input.requireSignature && !signature.valid) throw new PackSdkError('SIGNATURE_REQUIRED', 'Release signature not trusted: ' + signature.reason);
  return new PackSession(release, manifest, integrity.manifestDigest!, signature);
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
/** Fetch a published release by pack and digest from a static base URL (for example `/releases`). */
export async function fetchPackRelease(baseUrl: string, packId: string, manifestDigest: string, options: { readonly fetch?: FetchLike; readonly trust?: TrustStore | null; readonly requireSignature?: boolean } = {}): Promise<PackSession> {
  if (!/^[a-z0-9-]{1,80}$/.test(packId) || !/^[a-f0-9]{64}$/.test(manifestDigest)) throw new PackSdkError('NOT_FOUND', 'Invalid release reference');
  const get = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const dir = baseUrl.replace(/\/$/, '') + '/' + packId + '/' + manifestDigest + '/';
  const load = async (path: string, optional = false): Promise<Uint8Array | null> => {
    const response = await get(dir + path);
    if (!response.ok) { if (optional && response.status === 404) return null; throw new PackSdkError('FETCH_FAILED', 'Could not load ' + path + ' (' + response.status + ')'); }
    return new Uint8Array(await response.arrayBuffer());
  };
  const manifestBytes = (await load('manifest.json'))!;
  let manifest: PackManifestFile;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { throw new PackSdkError('MANIFEST_INVALID', 'Manifest is not JSON'); }
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 200) throw new PackSdkError('MANIFEST_INVALID', 'Invalid asset list');
  const assets = new Map<string, Uint8Array>();
  for (const a of manifest.assets) {
    if (!/^assets\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(a.path)) throw new PackSdkError('MANIFEST_INVALID', 'Invalid asset path');
    assets.set(a.path, (await load(a.path))!);
  }
  const signatureBytes = await load('signature.json', true);
  const signature = signatureBytes ? JSON.parse(new TextDecoder().decode(signatureBytes)) as ReleaseSignature : null;
  return loadPackRelease({ manifestBytes, expectedManifestDigest: manifestDigest, assets, signature, trust: options.trust ?? null, requireSignature: options.requireSignature ?? false });
}
export const digestOf = canonicalDigest;
