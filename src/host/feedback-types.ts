/**
 * Face-neutral feedback-type vocabulary shared by the Host and the Client
 * bundle. Lives under src/host so the Host compiler emits it, but it imports
 * nothing Node-specific: the Client program and esbuild bundle it too.
 */

/** One of the four community-feedback types the review card supports. */
export type FeedbackType = 'plugin-request' | 'harness-feature' | 'harness-defect' | 'custom';

/** The accepted feedback type roster, used at the wire and durable-file boundaries. */
export const FEEDBACK_TYPES = ['plugin-request', 'harness-feature', 'harness-defect', 'custom'] as const;

/** User-selected submission language; absence means the English default. */
export type DraftLanguage = 'zh' | 'en';

/**
 * Resolve the draft submission language: an explicit selection wins, and
 * English is the default only when the user has not selected one.
 *
 * @param language - the user-selected language, or null/undefined when unset.
 * @returns the effective language.
 */
export function effectiveLanguage(language: DraftLanguage | null | undefined): DraftLanguage {
  return language === 'zh' ? 'zh' : 'en';
}
