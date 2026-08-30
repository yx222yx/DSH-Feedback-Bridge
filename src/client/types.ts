import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { PrivacyKind, PrivacySeverity } from '../host/assist-schema.js';
import type { SimilarityOutcome, SimilarityResult, SimilaritySourceKind, SimilaritySourceState } from '../host/similarity.js';
import type { DraftLanguage } from '../host/feedback-types.js';
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
  | 'assist.typeReason'
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
  | 'assist.error.notJson'
  | 'assist.error.truncated'
  | 'assist.error.type'
  | 'assist.error.typeReason'
  | 'assist.error.missingInfo'
  | 'assist.error.missing.field'
  | 'assist.error.missing.reason'
  | 'assist.error.missing.importance'
  | 'assist.error.draft'
  | 'assist.error.draft.title'
  | 'assist.error.draft.scenario'
  | 'assist.error.draft.gap'
  | 'assist.error.draft.desired'
  | 'assist.error.draft.context'
  | 'assist.error.privacy'
  | 'assist.error.privacy.kind'
  | 'assist.error.privacy.severity'
  | 'assist.error.privacy.quote'
  | 'assist.error.privacy.reason'
  | 'assist.errorCode'
  | 'privacy.title'
  | 'privacy.severity.critical'
  | 'privacy.severity.warning'
  | 'privacy.severity.info'
  | 'privacy.kind.secret'
  | 'privacy.kind.personal-info'
  | 'privacy.kind.private-path'
  | 'privacy.kind.confidential'
  | 'privacy.kind.excess-context'
  | 'privacy.excessContextReason'
  | 'status.noModelContext'
  | 'status.assistFailed'
  | 'similarity.title'
  | 'similarity.checking'
  | 'similarity.idleHint'
  | 'similarity.results'
  | 'similarity.noResults'
  | 'similarity.matches'
  | 'similarity.reason.plugin'
  | 'similarity.retry'
  | 'similarity.failed'
  | 'similarity.partial'
  | 'similarity.source.discussion'
  | 'similarity.source.plugin'
  | 'similarity.source.documentation'
  | 'similarity.failed.rate-limited'
  | 'similarity.failed.timeout'
  | 'similarity.failed.network'
  | 'similarity.failed.parse'
  | 'submission.title'
  | 'submission.account'
  | 'submission.account.select'
  | 'submission.account.continue'
  | 'submission.category'
  | 'submission.language'
  | 'submission.destination'
  | 'submission.confirm'
  | 'submission.submit'
  | 'submission.back'
  | 'submission.export'
  | 'submission.submitting'
  | 'submission.created'
  | 'submission.open'
  | 'submission.failed.authorization-required'
  | 'submission.failed.authorization-expired'
  | 'submission.failed.permission-denied'
  | 'submission.failed.validation-rejected'
  | 'submission.failed.category-unavailable'
  | 'submission.failed.rate-limited'
  | 'submission.failed.network'
  | 'submission.unknown'
  | 'submission.unknown.guidance'
  | 'submission.guidance.reauth'
  | 'submission.guidance.scopes'
  | 'oauth.signIn'
  | 'oauth.starting'
  | 'oauth.waiting'
  | 'oauth.open'
  | 'oauth.cancel'
  | 'oauth.disconnect'
  | 'oauth.retry'
  | 'oauth.disclosure'
  | 'oauth.failed.denied'
  | 'oauth.failed.state-expired'
  | 'oauth.failed.exchange-failed'
  | 'oauth.failed.user-failed'
  | 'oauth.failed.network';

/** Namespace-bound translate function delivered by the locale service. */
export type T = TranslateNS<'dsh-feedback-bridge'>;

/** The five editable draft field names. */
export type FeedbackFieldKey = 'title' | 'scenario' | 'gap' | 'desired' | 'context';

/** One of the four community-feedback types the review card supports. */
export type FeedbackType = 'plugin-request' | 'harness-feature' | 'harness-defect' | 'custom';

export type { DraftLanguage } from '../host/feedback-types.js';

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
  signal?: AbortSignal;
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

export type { PrivacyKind as PrivacyFindingKind, PrivacySeverity } from '../host/assist-schema.js';
export type { SimilarityFailureCode, SimilarityOutcome, SimilarityResult, SimilaritySourceKind, SimilaritySourceState } from '../host/similarity.js';
export type { DiscussionCategory, GitHubSubmissionFailureCode, OfficialDestination } from '../host/github.js';
export type { SubmissionConfirmOutcome, SubmissionPrepareResult, SubmissionTransport } from './submission.js';
export type { SubmissionPanelState } from './components/SubmitPanel.js';

/** One read-only privacy finding; findings never rewrite content. */
export interface PrivacyFinding {
  id: string;
  severity: PrivacySeverity;
  kind: PrivacyKind;
  location: 'source' | 'draft';
  sourceId?: string;
  field?: FeedbackFieldKey;
  excerpt: string;
  /** Locale-owned message key for synthetic findings; content excerpts use none. */
  reasonKey?: FeedbackBridgeKey;
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
  privacyFindings: { kind: PrivacyKind; severity: PrivacySeverity; quote: string; reason: string }[];
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

/** Minimal feedback intent sent to the similarity route; never carries conversation content. */
export interface SimilarityRequest {
  scenario: string;
  gap: string;
  desired: string;
  type: FeedbackType;
  language: DraftLanguage | null;
}

/** Serialized similarity transport; the caller may cancel a stale check. */
export interface SimilarityTransport {
  run(input: SimilarityRequest, signal?: AbortSignal): Promise<SimilarityOutcome>;
}

/** Workspace similarity panel state machine. */
export type SimilarityPanelState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; outcome: SimilarityOutcome }
  | { phase: 'failed' };

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