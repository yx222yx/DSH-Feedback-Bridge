import { FEEDBACK_TYPES, type FeedbackType } from './feedback-types.js';
import type { MissingFieldKey } from './assist-schema.js';

/**
 * Face-neutral per-type information needs. The Host prompt embeds the current
 * type's roster so the model requests relevant information, and tests assert
 * the rosters directly; optional omissions stay non-blocking suggestions.
 */

/** The missing-information topics relevant to each feedback type. */
export const TYPE_INFORMATION_NEEDS: Record<FeedbackType, readonly MissingFieldKey[]> = {
  'plugin-request': ['title', 'scenario', 'workaround', 'audience', 'desired'],
  'harness-feature': ['title', 'scenario', 'gap', 'desired', 'environment'],
  'harness-defect': ['title', 'scenario', 'reproduction', 'environment', 'version', 'desired'],
  custom: ['title', 'scenario', 'desired', 'context'],
};

/**
 * The information-need roster for one feedback type.
 *
 * @param type - the feedback type.
 * @returns the relevant missing-information topics.
 */
export function informationNeedsFor(type: FeedbackType): readonly MissingFieldKey[] {
  return TYPE_INFORMATION_NEEDS[type];
}

/** The accepted feedback type roster, re-exported for prompt assembly. */
export { FEEDBACK_TYPES };
