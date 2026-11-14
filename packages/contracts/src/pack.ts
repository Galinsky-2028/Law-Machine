import type { SourceRef } from './model.ts';

/**
 * Pack contract v1: the data-only public shape of a published Law Machine model.
 * A pack is authored as JSON plus preserved source bytes, compiled into an
 * immutable release, and executed by the same interpreter in browser and server.
 * Nothing here is executable code; every legal effect is declared data.
 */
export const PACK_FORMAT = 'law-machine-pack-v1' as const;
export const PACK_ENGINE_VERSION = '1.0.0' as const;
export const PACK_CAPABILITIES = Object.freeze({
  operations: ['record', 'create-obligation', 'route', 'schedule'],
  calendars: ['civil-day'],
  domains: ['institutional-process', 'deadlines', 'resource-accounting']
});

export type FactValue = boolean | number | string;
export type FactType = 'boolean' | 'number' | 'string';
export type LegislativeStatus = 'draft' | 'introduced' | 'enacted' | 'repealed';
/** `source` defaults to the citing framework's pinned source. */
export type AuthoredRef = { readonly provision: string; readonly quote: string; readonly source?: string };

export type PackSourceMeta = {
  readonly id: string;
  readonly title: string;
  /** `fictional` text is invented for demonstration and is never real law. */
  readonly kind: 'bill' | 'baseline' | 'fictional';
  readonly file: string;
  readonly format: 'text' | 'markdown';
  readonly origin: string;
  readonly retrievedAt: string | null;
  readonly rights: string;
  readonly officialUrl?: string;
};
export type PackActor = {
  readonly id: string; readonly name: string;
  readonly kind: 'agency' | 'court' | 'person' | 'organization' | 'other';
  readonly description: string;
  readonly group?: string;
};
export type PackFact = {
  readonly id: string; readonly type: FactType; readonly label: string;
  readonly description: string;
  readonly unit?: string;
};
export type PackCalendar = {
  readonly id: string; readonly version: string; readonly timeZone: string;
  readonly weekendDays: readonly number[];
  readonly observedHolidays: readonly string[];
  /** Where the calendar choices come from: a cited source or a declared assumption. */
  readonly basis: string;
};
export type DeadlineSpec<Ref> = {
  readonly id: string; readonly label: string; readonly calendarId: string;
  readonly amount: number;
  readonly unit: 'calendar-day' | 'business-day' | 'calendar-month';
  readonly startCounting: 'exclude-trigger' | 'include-trigger';
  readonly monthEnd: 'clamp' | 'unresolved';
  readonly nonBusinessDue: 'extend' | 'keep' | 'unresolved';
  readonly sourceRefs: readonly Ref[];
  readonly interpretationId?: string;
};
export type ExceptionLabel<Ref> = { readonly id: string; readonly label: string; readonly sourceRefs: readonly Ref[] };
export type EffectBinding<Ref> = (
  | { readonly kind: 'record'; readonly emits?: string; readonly setFacts?: Readonly<Record<string, FactValue>>;
      readonly status?: { readonly force: 'right' | 'permission' | 'prohibition'; readonly holderId: string; readonly action: string };
      readonly transfer?: { readonly account: string; readonly to: string; readonly amountFact: string } }
  | { readonly kind: 'create-obligation'; readonly action: string; readonly deadlineId: string | null;
      readonly onPerformEmits: string; readonly onBreachEmits?: string }
  | { readonly kind: 'route'; readonly to: string; readonly emits: string; readonly transitAction?: string }
  | { readonly kind: 'schedule'; readonly emits: string; readonly deadlineId: string;
      /** Count from the first earlier event of this kind (e.g. relation back), not the trigger. */
      readonly anchorEvent?: string }
) & {
  /** Authored semantic identity used to align frameworks; never an event index. */
  readonly checkpoint?: string;
  readonly summary: string;
  readonly exceptions?: readonly ExceptionLabel<Ref>[];
  /** Days after the assumed enactment date before this rule operates (proposals only). */
  readonly effectiveAfterEnactmentDays?: number;
};
export type Condition =
  | { readonly op: 'truth'; readonly value: Scalar }
  | { readonly op: 'eq' | 'gte' | 'lte'; readonly left: Scalar; readonly right: Scalar }
  | { readonly op: 'not'; readonly arg: Condition }
  | { readonly op: 'and' | 'or'; readonly terms: readonly Condition[] }
  | { readonly op: 'unknown' };
export type Scalar = { readonly op: 'literal'; readonly value: FactValue } | { readonly op: 'fact-value'; readonly key: string };
export type PackRule<Ref> = {
  readonly id: string;
  readonly modal: 'obligation' | 'permission' | 'prohibition' | 'right' | 'power';
  readonly sourceRefs: readonly Ref[];
  readonly trigger: string;
  readonly when: Condition;
  readonly exceptions: readonly Condition[];
  readonly operation: 'route' | 'record' | 'create-obligation' | 'schedule';
  readonly actorId: string;
  readonly explanationKey: string;
  readonly after?: readonly string[];
  readonly effect: EffectBinding<Ref>;
};
export type CoverageEntry = { readonly provision: string; readonly mode: 'modeled' | 'explanatory-only' | 'ambiguous' | 'unsupported'; readonly reason?: string };
export type PackFramework<Ref> = {
  readonly id: string; readonly label: string;
  readonly role: 'baseline' | 'proposal';
  readonly billId: string; readonly version: string; readonly versionId: string;
  readonly status: LegislativeStatus;
  readonly jurisdiction: string; readonly agency: string;
  /** Date of the legal snapshot this framework models. */
  readonly asOf: string;
  readonly sourceId: string;
  readonly rules: readonly PackRule<Ref>[];
  readonly coverage: readonly CoverageEntry[];
  readonly gaps: readonly string[];
};
export type InterpretationAlternative<Ref> = { readonly id: string; readonly label: string; readonly description: string; readonly frameworkId: string; readonly sourceRefs: readonly Ref[] };
export type PackInterpretation<Ref> = {
  readonly id: string; readonly question: string;
  readonly alternatives: readonly InterpretationAlternative<Ref>[];
  /** A reviewed editorial choice; absent means the conflict stays visibly unresolved. */
  readonly chosen?: { readonly alternativeId: string; readonly reviewerId: string; readonly rationale: string };
};
export type PackAssumption = {
  readonly id: string; readonly label: string; readonly description: string;
  readonly classification: 'interpretation' | 'empirical' | 'hypothetical' | 'unknown';
  readonly limitations: readonly string[];
};
export type Behavior = {
  /** Duty action or route transit this operational assumption drives. */
  readonly action: string;
  readonly mode: 'perform-after' | 'never';
  readonly delay?: { readonly amount: number; readonly unit: 'calendar-day' | 'business-day' };
  readonly assumptionId: string;
};
export type ScriptedEvent = { readonly id: string; readonly day: number; readonly kind: string; readonly actorId: string; readonly label: string };
export type ParameterSpec = {
  readonly id: string; readonly label: string; readonly help: string;
  readonly control: 'boolean' | 'integer' | 'choice' | 'tristate';
  readonly target:
    | { readonly kind: 'fact'; readonly factId: string }
    | { readonly kind: 'behavior-delay'; readonly action: string }
    | { readonly kind: 'behavior-mode'; readonly action: string }
    | { readonly kind: 'interpretation'; readonly interpretationId: string }
    | { readonly kind: 'enactment-offset' };
  readonly min?: number; readonly max?: number; readonly unit?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly assumptionId?: string;
};
export type WorkloadModel = {
  /** Duty action whose performance time is produced by the queue instead of a fixed delay. */
  readonly action: string;
  readonly arrivalsPerDay: number; readonly workers: number; readonly unitsPerWorkerDay: number;
  readonly unitsPerItem: number; readonly outageDays: readonly number[];
  readonly assumptionId: string; readonly sourceKind: 'assumption' | 'empirical';
};
export type ScenarioSpec = {
  readonly id: string; readonly title: string; readonly question: string; readonly summary: string;
  readonly hypothetical: true;
  readonly startDate: string; readonly calendarId: string; readonly seed: number; readonly horizonDays: number;
  /** Offset in days from scenario start to the assumed enactment date (negative = earlier). */
  readonly enactment: { readonly assume: boolean; readonly offsetDays: number };
  readonly facts: Readonly<Record<string, FactValue>>;
  readonly unknownFacts: readonly { readonly factId: string; readonly reason: string }[];
  readonly interpretationChoices: Readonly<Record<string, string>>;
  readonly events: readonly ScriptedEvent[];
  readonly behaviors: readonly Behavior[];
  readonly parameters: readonly ParameterSpec[];
  readonly workload?: WorkloadModel;
  readonly assumptions: readonly string[];
  readonly unresolved: readonly string[];
  readonly learn: readonly string[];
  /** Independently specified expectations (golden checkpoints), per framework id. */
  readonly expected: Readonly<Record<string, readonly ExpectedCheckpoint[]>>;
  /** Independently computed end-of-run fact values (e.g. account balances), per framework id. */
  readonly expectedFacts?: Readonly<Record<string, Readonly<Record<string, FactValue>>>>;
  /** Accounts whose total must be conserved by every run (resource accounting). */
  readonly conservedAccounts?: readonly string[];
  readonly tour?: readonly TourStep[];
};
export type ExpectedCheckpoint = {
  readonly checkpoint: string;
  readonly present: boolean;
  readonly dutyState?: 'none' | 'pending' | 'satisfied' | 'breached' | 'unknown';
  readonly eventDate?: string | null;
  readonly dueDate?: string | null;
  readonly reasoning: string;
};
export type TourStep = { readonly focus: FocusTarget; readonly title: string; readonly body: string };
export type FocusTarget =
  | { readonly kind: 'actor'; readonly id: string }
  | { readonly kind: 'provision'; readonly versionId: string; readonly id: string }
  | { readonly kind: 'rule'; readonly frameworkId: string; readonly id: string }
  | { readonly kind: 'checkpoint'; readonly id: string }
  | { readonly kind: 'event'; readonly id: string };
export type SceneNode = { readonly actorId: string; readonly x: number; readonly y: number; readonly icon: 'person' | 'agency' | 'office' | 'court' | 'portal' | 'ledger' | 'oversight'; readonly group?: string };
export type SceneEdge = { readonly id: string; readonly from: string; readonly to: string; readonly kind: 'route' | 'authority'; readonly label: string; readonly eventKinds: readonly string[] };
export type Scene = { readonly id: string; readonly title: string; readonly width: number; readonly height: number; readonly groups: readonly { readonly id: string; readonly label: string }[]; readonly nodes: readonly SceneNode[]; readonly edges: readonly SceneEdge[] };
export type GlossaryEntry<Ref> = { readonly id: string; readonly term: string; readonly plain: string; readonly detail: string; readonly aliases: readonly string[]; readonly sourceRefs: readonly Ref[]; readonly related: readonly string[] };
export type ExplanationTemplate = { readonly plain: string; readonly detail: string };

/** Authoring input (content/packs/<id>/pack.json). References use displayed provision paths. */
export type AuthoredPack = {
  readonly format: typeof PACK_FORMAT;
  readonly packId: string; readonly title: string; readonly question: string; readonly summary: string;
  readonly domain: string;
  /** Fictional packs describe invented law for demonstration only. */
  readonly fictional: boolean;
  readonly disclaimers: readonly string[];
  readonly releaseLabel: string; readonly releasedAt: string;
  readonly sources: readonly PackSourceMeta[];
  readonly actors: readonly PackActor[];
  readonly facts: readonly PackFact[];
  readonly calendars: readonly PackCalendar[];
  readonly deadlines: readonly DeadlineSpec<AuthoredRef>[];
  readonly frameworks: readonly PackFramework<AuthoredRef>[];
  readonly interpretations: readonly PackInterpretation<AuthoredRef>[];
  readonly assumptions: readonly PackAssumption[];
  readonly scenarios: readonly ScenarioSpec[];
  readonly scene: Scene;
  readonly glossary: readonly GlossaryEntry<AuthoredRef>[];
  readonly explanations: Readonly<Record<string, ExplanationTemplate>>;
  readonly eventLabels: Readonly<Record<string, string>>;
};

export type PackProvision = {
  readonly id: string; readonly versionId: string; readonly parentId: string | null;
  readonly path: string; readonly citation: string; readonly text: string;
  readonly span: { readonly kind: 'line' | 'utf16-offset' | 'page'; readonly start: number; readonly end: number };
};
export type PackDocument = {
  readonly sourceId: string; readonly versionId: string; readonly sourceDigest: string;
  readonly title: string; readonly kind: PackSourceMeta['kind']; readonly format: 'text' | 'markdown';
  readonly origin: string; readonly retrievedAt: string | null; readonly rights: string;
  readonly officialUrl: string | null;
  /** Content-addressed asset path holding the exact original bytes. */
  readonly assetPath: string;
  readonly provisions: readonly PackProvision[];
};
export type CoverageReport = {
  readonly frameworkId: string;
  readonly counts: Readonly<Record<'modeled' | 'explanatory-only' | 'ambiguous' | 'unsupported' | 'unmapped', number>>;
  readonly statement: string;
  readonly entries: readonly { readonly provisionId: string; readonly path: string; readonly mode: CoverageEntry['mode'] | 'unmapped'; readonly reason: string | null; readonly ruleIds: readonly string[] }[];
};
/** Compiled public release bundle: every reference is pinned to a version, digest and exact quote. */
export type PackRelease = Omit<AuthoredPack, 'sources' | 'deadlines' | 'frameworks' | 'interpretations' | 'glossary'> & {
  readonly schemaVersion: '1.0.0';
  readonly engineVersion: typeof PACK_ENGINE_VERSION;
  readonly documents: readonly PackDocument[];
  readonly deadlines: readonly DeadlineSpec<SourceRef>[];
  readonly frameworks: readonly (PackFramework<SourceRef> & { readonly sourceDigest: string; readonly ruleOrder: readonly string[] })[];
  readonly interpretations: readonly PackInterpretation<SourceRef>[];
  readonly glossary: readonly GlossaryEntry<SourceRef>[];
  readonly coverage: readonly CoverageReport[];
  readonly requires: typeof PACK_CAPABILITIES;
};

export type CatalogRelease = {
  readonly releaseId: string; readonly manifestDigest: string; readonly label: string;
  readonly publishedAt: string;
  readonly status: 'current' | 'superseded' | 'withdrawn';
  readonly note: string | null;
  readonly signed: boolean;
};
export type CatalogPack = {
  readonly packId: string; readonly title: string; readonly question: string; readonly summary: string;
  readonly domain: string; readonly fictional: boolean;
  readonly statusLabel: string; readonly jurisdiction: string; readonly baselineAsOf: string | null;
  readonly scenarioCount: number;
  readonly current: string | null;
  readonly releases: readonly CatalogRelease[];
};
export type Catalog = { readonly format: 'law-machine-catalog-v1'; readonly generatedFrom: string; readonly packs: readonly CatalogPack[]; readonly unavailable: readonly { readonly packId: string; readonly title: string; readonly reason: string }[] };
