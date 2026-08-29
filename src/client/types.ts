import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';

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
  | 'guidance.step4';

/** Namespace-bound translate function delivered by the locale service. */
export type T = TranslateNS<'dsh-feedback-bridge'>;

/** The five editable draft field names. */
export type FeedbackFieldKey = 'title' | 'scenario' | 'gap' | 'desired' | 'context';

/** Editable draft fields without the fixed session type. */
export type FeedbackDraftFields = Record<FeedbackFieldKey, string>;

/** A fresh custom-feedback draft: five editable fields plus the fixed type. */
export interface FeedbackDraft extends FeedbackDraftFields {
  type: 'custom';
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
  /** Discard the in-memory draft (cancellation). */
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

/** Serialized draft transport handle owned by the Client plugin. */
export interface DraftPersistence {
  /** Current generation; bumped on every remove. */
  generation(): number;
  /** Read the persisted draft, or null when none exists. */
  load(): Promise<FeedbackDraftFields | null>;
  /** Persist the five draft fields; resolves false when a discard happened first. */
  save(draft: FeedbackDraftFields): Promise<boolean>;
  /** Delete the persisted draft. */
  remove(): Promise<boolean>;
  /** Best-effort unload fallback; never carries success semantics. */
  keepalive(draft: FeedbackDraftFields | null): void;
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
export type WorkspaceNotice = 'copied' | 'exported' | 'copyFailed' | 'restored' | 'autosaveFailed' | 'removeFailed' | 'loadFailed';

/** Map a workspace notice state to its locale dictionary key. */
export const NOTICE_STATUS: Record<WorkspaceNotice, FeedbackBridgeKey> = {
  copied: 'status.copied',
  exported: 'status.exported',
  copyFailed: 'status.copyFailed',
  restored: 'status.restored',
  autosaveFailed: 'status.autosaveFailed',
  removeFailed: 'status.removeFailed',
  loadFailed: 'status.loadFailed',
};
