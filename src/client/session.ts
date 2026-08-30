import type { FeedbackDraft, FeedbackDraftFields, FeedbackFieldKey, FeedbackSessionController } from './types.js';
import type { ConfirmedSourceRecord } from './sources.js';

/** Section headings passed to the Markdown builder, locale-owned at the call site. */
export interface DraftMarkdownHeadings {
  scenario: string;
  gap: string;
  desired: string;
  context: string;
}

/**
 * A fresh custom-feedback draft: five editable fields plus the fixed
 * custom-feedback session type. Nothing here is persisted.
 *
 * @returns the empty draft object.
 */
export function emptyFeedbackDraft(): FeedbackDraft {
  return { type: 'custom', title: '', scenario: '', gap: '', desired: '', context: '' };
}

/**
 * Stable filename for the exported draft Markdown file.
 *
 * @returns the exported file name.
 */
export function feedbackDraftFileName(): string {
  return 'dsh-community-feedback-draft.md';
}

/**
 * Build the exact Markdown a draft exports: an optional H1 title plus one
 * section per non-empty field, headed by locale-owned labels. The review
 * card shows this exact string, and copy/export use it verbatim.
 *
 * @param draft - feedback draft fields.
 * @param headings - locale-owned section headings for scenario, gap,
 * desired, and context.
 * @returns the generated Markdown text.
 */
export function buildDraftMarkdown(draft: Partial<FeedbackDraftFields>, headings: DraftMarkdownHeadings): string {
  const sections: string[] = [];
  const fieldOrder: Array<keyof DraftMarkdownHeadings> = ['scenario', 'gap', 'desired', 'context'];
  for (const key of fieldOrder) {
    const value = String(draft[key] ?? '').trim();
    if (value !== '') sections.push(`## ${headings[key]}\n\n${value}`);
  }
  const title = String(draft.title ?? '').trim();
  const parts: string[] = [];
  if (title !== '') parts.push(`# ${title}`);
  parts.push(...sections);
  return parts.join('\n\n');
}

/**
 * In-memory feedback-session controller owned by the Client plugin
 * lifecycle. The sidebar trigger and the workspace share one instance;
 * disposing the plugin clears the draft. Nothing is written to storage.
 */
export function createFeedbackSessionController(): FeedbackSessionController {
  let draft: FeedbackDraft | null = null;
  let sources: ConfirmedSourceRecord[] = [];
  return {
    openOrResume() {
      if (draft === null) draft = emptyFeedbackDraft();
      return draft;
    },
    getDraft() {
      return draft;
    },
    update(patch: Partial<FeedbackDraftFields>) {
      // The update contract implies an open draft; the cast keeps the
      // legacy null-draft spread behavior (a patch-only object) unchanged.
      draft = { ...draft, ...patch } as FeedbackDraft;
    },
    restore(persisted: FeedbackDraft) {
      draft = { ...persisted };
    },
    getSources() {
      return sources;
    },
    setSources(next: ConfirmedSourceRecord[]) {
      sources = [...next];
    },
    cancel() {
      draft = null;
      sources = [];
    },
    dispose() {
      draft = null;
      sources = [];
    },
  };
}
