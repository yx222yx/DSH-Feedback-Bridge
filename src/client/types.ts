import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConfirmedSourceRecord } from './sources.js';

/** Dictionary key union of the plugin's locale namespace. */
export type FeedbackBridgeKey =
  | 'nav'
  | 'settings.label'
  | 'title'
  | 'loading'
  | 'errorPrefix'
  | 'statusPrefix'
  | 'workspace.title'
  | 'workspace.type'
  | 'field.title'
  | 'field.scenario'
  | 'field.gap'
  | 'field.desired'
  | 'field.context'
  | 'field.titlePlaceholder'
  | 'preview.title'
  | 'action.copy'
  | 'action.export'
  | 'action.cancel'
  | 'action.close'
  | 'workspace.draftLabel'
  | 'status.copied'
  | 'status.exported'
  | 'status.copyFailed'
  | 'status.needTitle'
  | 'status.restored'
  | 'status.autosaveFailed'
  | 'status.removeFailed'
  | 'status.loadFailed'
  | 'discard.title'
  | 'discard.body'
  | 'discard.confirm'
  | 'discard.keep'
  | 'guidance.title'
  | 'guidance.destination'
  | 'guidance.open'
  | 'guidance.step1'
  | 'guidance.step2'
  | 'guidance.step3'
  | 'guidance.step4'
  | 'sources.title'
  | 'sources.candidates'
  | 'sources.confirmed'
  | 'sources.empty'
  | 'sources.noSession'
  | 'sources.recommended'
  | 'sources.sensitive'
  | 'sources.confirm'
  | 'sources.confirmedState'
  | 'sources.remove'
  | 'sources.expand'
  | 'sources.collapse'
  | 'sources.quotePlaceholder'
  | 'sources.truncated'
  | 'sources.otherSession'
  | 'sources.noneConfirmed'
  | 'sources.role.user'
  | 'sources.role.assistant'
  | 'sources.role.steering'
  | 'sources.role.context'
  | 'sources.role.tool'
  | 'sources.role.error'
  | 'sources.role.session'
  | 'sources.reason.recent'
  | 'sources.reason.error'
  | 'sources.reason.tool-error'
  | 'sources.reason.turn-error'
  | 'sources.reason.session'
  | 'sources.diag.title'
  | 'sources.diag.cwd'
  | 'sources.diag.preset'
  | 'sources.diag.version'
  | 'sources.diag.session'
  | 'sources.diag.turnMaxTokens'
  | 'sources.diag.errorCode'
  | 'field.type'
  | 'type.plugin-request'
  | 'type.harness-feature'
  | 'type.harness-defect'
  | 'type.custom'
  | 'language.label'
  | 'language.default'
  | 'language.zh'
  | 'language.en'
  | 'assist.title'
  | 'assist.generate'
  | 'assist.generating'
  | 'assist.noSourcesOrSession'
  | 'assist.recommendedType'
  | 'assist.useRecommendedType'
  | 'assist.importance.low'
  | 'assist.importance.medium'
  | 'assist.importance.high'
  | 'assist.apply'
  | 'assist.modelFailed'
  | 'assist.retry'
  | 'assist.repairTitle'
  | 'assist.revalidate'
  | 'assist.discardRepair'
  | 'assist.overwriteTitle'
  | 'assist.overwriteBody'
  | 'assist.replace'
  | 'assist.keepEdit'
  | 'privacy.title'
  | 'privacy.severity.critical'
  | 'privacy.severity.warning'
  | 'privacy.severity.info'
  | 'privacy.kind.secret'
  | 'privacy.kind.personal-info'
  | 'privacy.kind.private-path'
  | 'privacy.kind.confidential'
  | 'privacy.kind.excess-context'
  | 'status.noModelContext'
  | 'status.assistFailed';

/** Namespace-bound translate function delivered by the locale service. */
export type T = TranslateNS<'dsh-feedback-bridge'>;

/** The five editable draft field names. */
export type FeedbackFieldKey = 'title' | 'scenario' | 'gap' | 'desired' | 'context';

/** One of the four community-feedback types the review card supports. */
export type FeedbackType = 'plugin-request' | 'harness-feature' | 'harness-defect' | 'custom';

/** User-selected submission language; absence means the English default. */
export type DraftLanguage = 'zh' | 'en';

/** Editable draft fields without the fixed session type. */
export type FeedbackDraftFields = Record<FeedbackFieldKey, string>;

/** A feedback draft: five editable fields plus the authoritative type and optional language. */
export interface FeedbackDraft extends FeedbackDraftFields {
  type: FeedbackType;
  language?: DraftLanguage;
}

/** In-memory feedback-session controller shared by the sidebar trigger and the workspace. */
export interface FeedbackSessionController {
  /** Resume the in-progress draft or create a fresh custom-feedback one. */
  openOrResume(): FeedbackDraft;
  /** Current draft, or null after cancel/dispose. */
  getDraft(): FeedbackDraft | null;
  /** Merge a field patch into the in-memory draft. */
  update(patch: Partial<FeedbackDraftFields>): void;
  /** Replace the in-memory draft with a restored persisted one. */
  restore(persisted: FeedbackDraft): void;
  /** Current authoritative feedback type. */
  getType(): FeedbackType;
  /** Set the authoritative feedback type (user override). */
  setType(type: FeedbackType): void;
  /** Current selected submission language, or undefined when unset. */
  getLanguage(): DraftLanguage | undefined;
  /** Set the submission language; undefined clears the selection (English default). */
  setLanguage(language: DraftLanguage | undefined): void;
  /** Current confirmed sources. */
  getSources(): ConfirmedSourceRecord[];
  /** Replace the confirmed sources (restore or discard). */
  setSources(sources: ConfirmedSourceRecord[]): void;
  /** Discard the in-memory draft and sources (cancellation). */
  cancel(): void;
  /** Plugin-unload cleanup: drop the draft and any references. */
  dispose(): void;
}

/** Minimal fetch-like shape the persistence transport needs. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal request init the persistence transport sends. */
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  keepalive?: boolean;
}

/** fetch-like function; defaults to the global fetch in the browser. */
export type FetchLike = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

/** A restored persisted draft: the five public fields, confirmed sources, type, and language. */
export interface PersistedFeedbackDraft {
  fields: FeedbackDraftFields;
  sources: ConfirmedSourceRecord[];
  type: FeedbackType;
  language?: DraftLanguage;
}

/** Serialized draft transport handle owned by the Client plugin. */
export interface DraftPersistence {
  /** Current generation; bumped on every remove. */
  generation(): number;
  /** Read the persisted draft (fields, sources, type, language), or null when none exists. */
  load(): Promise<PersistedFeedbackDraft | null>;
  /** Persist the draft fields, type, language, and confirmed sources; resolves false when a discard happened first. */
  save(draft: FeedbackDraft, sources: readonly ConfirmedSourceRecord[]): Promise<boolean>;
  /** Delete the persisted draft. */
  remove(): Promise<boolean>;
  /** Best-effort unload fallback; never carries success semantics. */
  keepalive(draft: FeedbackDraft | null, sources: readonly ConfirmedSourceRecord[]): void;
}

/** Advisory privacy finding classes the deterministic scan can report. */
export type PrivacyFindingKind = 'secret' | 'personal-info' | 'private-path' | 'confidential' | 'excess-context';

/** Advisory severity ladder shown in the privacy panel. */
export type PrivacySeverity = 'info' | 'warning' | 'critical';

/** One read-only privacy finding; findings never rewrite content. */
export interface PrivacyFinding {
  id: string;
  severity: PrivacySeverity;
  kind: PrivacyFindingKind;
  location: 'source' | 'draft';
  sourceId?: string;
  field?: FeedbackFieldKey;
  excerpt: string;
}

/** One feedback-assist request from the Client to the Host route. */
export interface AssistRequest {
  sessionId: string;
  language: DraftLanguage | null;
  currentType: FeedbackType;
  sources: ConfirmedSourceRecord[];
}

/** A validated model suggestion; advisory only, never auto-applied. */
export interface AssistSuggestion {
  type: FeedbackType;
  typeReason: string;
  missingInfo: { field: string; reason: string; importance: 'low' | 'medium' | 'high' }[];
  draft: FeedbackDraftFields;
  privacyFindings: { kind: string; severity: PrivacySeverity; quote: string; reason: string }[];
}

/** Discriminated assist outcome as returned by the Host route. */
export type AssistOutcome =
  | { status: 'ok'; result: AssistSuggestion }
  | { status: 'repair-needed'; rawText: string; errors: string[] }
  | { status: 'model-failed'; code: string; message: string }
  | { status: 'no-model-context' };

/** Serialized assist transport handle owned by the Client plugin. */
export interface AssistTransport {
  run(request: AssistRequest): Promise<AssistOutcome>;
}

/** Host status payload served to the Client. */
export interface HostStatusPayload {
  name: string;
  status: string;
  version: string;
  dshVersion: string | null;
  compatible: boolean | null;
}

/** Workspace notice states mapped to locale dictionary keys. */
export type WorkspaceNotice = 'copied' | 'exported' | 'copyFailed' | 'restored' | 'autosaveFailed' | 'removeFailed' | 'loadFailed' | 'noModelContext' | 'assistFailed';

/** Map a workspace notice state to its locale dictionary key. */
export const NOTICE_STATUS: Record<WorkspaceNotice, FeedbackBridgeKey> = {
  copied: 'status.copied',
  exported: 'status.exported',
  copyFailed: 'status.copyFailed',
  restored: 'status.restored',
  autosaveFailed: 'status.autosaveFailed',
  removeFailed: 'status.removeFailed',
  loadFailed: 'status.loadFailed',
  noModelContext: 'status.noModelContext',
  assistFailed: 'status.assistFailed',
};
