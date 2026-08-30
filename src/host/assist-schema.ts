import { FEEDBACK_TYPES, type FeedbackType } from './feedback-types.js';

/**
 * Structured model-output contract for the feedback-assist call, plus the
 * pure parse/validate pipeline. The schema is mirrored in the instruction
 * prompt, but the prompt wording is never asserted by tests: this module is
 * the single runtime authority that turns raw model text into a validated
 * {@link AssistResult} or a repair-needed outcome.
 *
 * Face-neutral module: it imports nothing Node-specific and is bundled into
 * the Client as well, so repair re-validation runs the same rules locally.
 */

/** Topics the model may flag as missing but non-mandatory information. */
export type MissingFieldKey =
  | 'title'
  | 'scenario'
  | 'gap'
  | 'desired'
  | 'context'
  | 'reproduction'
  | 'environment'
  | 'version'
  | 'workaround'
  | 'audience';

/** Accepted missing-information topics. */
export const MISSING_FIELD_KEYS = [
  'title', 'scenario', 'gap', 'desired', 'context',
  'reproduction', 'environment', 'version', 'workaround', 'audience',
] as const;

/** Advisory privacy finding classes; findings never rewrite content. */
export type PrivacyKind = 'secret' | 'personal-info' | 'private-path' | 'confidential' | 'excess-context';

/** Accepted privacy finding classes. */
export const PRIVACY_KINDS = ['secret', 'personal-info', 'private-path', 'confidential', 'excess-context'] as const;

/** Advisory severity ladder shown in the privacy panel. */
export type PrivacySeverity = 'info' | 'warning' | 'critical';

/** Accepted severities. */
export const PRIVACY_SEVERITIES = ['info', 'warning', 'critical'] as const;

/** Importance of one missing-information suggestion. */
export type MissingImportance = 'low' | 'medium' | 'high';

/** One non-blocking missing-information suggestion. */
export interface AssistMissingInfo {
  field: MissingFieldKey;
  reason: string;
  importance: MissingImportance;
}

/** One advisory privacy finding reported by the model. */
export interface AssistPrivacyFinding {
  kind: PrivacyKind;
  severity: PrivacySeverity;
  quote: string;
  reason: string;
}

/** The suggested public draft the model produced; every field stays editable. */
export interface AssistDraftSuggestion {
  title: string;
  scenario: string;
  gap: string;
  desired: string;
  context: string;
}

/** A fully validated structured model result. */
export interface AssistResult {
  type: FeedbackType;
  typeReason: string;
  missingInfo: AssistMissingInfo[];
  draft: AssistDraftSuggestion;
  privacyFindings: AssistPrivacyFinding[];
}

/** Outcome of parsing raw model text: a validated result, or repair material. */
export type AssistParseOutcome =
  | { status: 'ok'; result: AssistResult }
  | { status: 'repair-needed'; errors: string[] };

/** Byte cap on one reason string. */
export const MAX_TYPE_REASON = 500;
/** Max missing-information entries a result may carry. */
export const MAX_MISSING_INFO = 10;
/** Byte cap on one missing-information reason. */
export const MAX_MISSING_REASON = 300;
/** Max privacy findings a result may carry. */
export const MAX_PRIVACY_FINDINGS = 10;
/** Byte cap on one privacy quote excerpt. */
export const MAX_PRIVACY_QUOTE = 120;
/** Byte cap on one privacy reason. */
export const MAX_PRIVACY_REASON = 300;
/** Byte cap on a suggested draft title. */
export const MAX_DRAFT_TITLE = 200;
/** Byte cap on one suggested draft body field. */
export const MAX_DRAFT_FIELD = 16 * 1024;

/** The five suggested draft field names. */
const DRAFT_KEYS = ['title', 'scenario', 'gap', 'desired', 'context'] as const;

/** Required keys of one missing-information entry. */
const MISSING_KEYS = ['field', 'reason', 'importance'] as const;

/** Required keys of one privacy finding. */
const PRIVACY_KEYS = ['kind', 'severity', 'quote', 'reason'] as const;

/** UTF-8 byte length of a string; the caps are byte-based. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Assert a plain-object value, naming the offending path. */
function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(path + ' must be an object');
  }
}

/** Assert a string field, naming the offending path. */
function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(path + ' must be a string');
}

/** Assert a bounded string field. */
function assertBoundedString(value: unknown, path: string, cap: number): void {
  assertString(value, path);
  if (byteLength(value) > cap) throw new Error(path + ' exceeds the ' + cap + ' byte cap');
}

/** Assert a member of a closed roster. */
function assertMember(value: unknown, path: string, roster: readonly string[]): void {
  if (!(roster as readonly string[]).includes(value as string)) {
    throw new Error(path + ' must be one of: ' + roster.join(', '));
  }
}

/**
 * Collect every validation error in a parsed candidate, so repair-needed
 * surfaces a complete list instead of only the first failure.
 *
 * @param value - the parsed JSON candidate.
 * @returns one stable error string per invalid aspect.
 */
export function collectAssistErrors(value: unknown): string[] {
  const errors: string[] = [];
  const collect = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      errors.push((error as Error).message);
    }
  };
  collect(() => {
    assertObject(value, 'result');
    const record = value as Record<string, unknown>;
    collect(() => assertMember(record.type, 'type', FEEDBACK_TYPES as readonly string[]));
    collect(() => assertBoundedString(record.typeReason, 'typeReason', MAX_TYPE_REASON));
    collect(() => {
      if (!Array.isArray(record.missingInfo)) throw new Error('missingInfo must be an array');
      if (record.missingInfo.length > MAX_MISSING_INFO) {
        throw new Error('missingInfo must contain at most ' + MAX_MISSING_INFO + ' entries');
      }
      record.missingInfo.forEach((entry, index) => {
        collect(() => {
          assertObject(entry, 'missingInfo.' + index);
          const item = entry as Record<string, unknown>;
          assertMember(item.field, 'missingInfo.' + index + '.field', MISSING_FIELD_KEYS as readonly string[]);
          collect(() => assertBoundedString(item.reason, 'missingInfo.' + index + '.reason', MAX_MISSING_REASON));
          collect(() => assertMember(item.importance, 'missingInfo.' + index + '.importance', ['low', 'medium', 'high']));
        });
      });
    });
    collect(() => {
      assertObject(record.draft, 'draft');
      const draft = record.draft as Record<string, unknown>;
      for (const key of DRAFT_KEYS) {
        if (!(key in draft)) throw new Error('draft.' + key + ' is required');
      }
      for (const key of DRAFT_KEYS) {
        const cap = key === 'title' ? MAX_DRAFT_TITLE : MAX_DRAFT_FIELD;
        collect(() => assertBoundedString(draft[key], 'draft.' + key, cap));
      }
    });
    collect(() => {
      if (!Array.isArray(record.privacyFindings)) throw new Error('privacyFindings must be an array');
      if (record.privacyFindings.length > MAX_PRIVACY_FINDINGS) {
        throw new Error('privacyFindings must contain at most ' + MAX_PRIVACY_FINDINGS + ' entries');
      }
      record.privacyFindings.forEach((entry, index) => {
        collect(() => {
          assertObject(entry, 'privacyFindings.' + index);
          const item = entry as Record<string, unknown>;
          assertMember(item.kind, 'privacyFindings.' + index + '.kind', PRIVACY_KINDS as readonly string[]);
          collect(() => assertMember(item.severity, 'privacyFindings.' + index + '.severity', PRIVACY_SEVERITIES as readonly string[]));
          collect(() => assertBoundedString(item.quote, 'privacyFindings.' + index + '.quote', MAX_PRIVACY_QUOTE));
          collect(() => assertBoundedString(item.reason, 'privacyFindings.' + index + '.reason', MAX_PRIVACY_REASON));
        });
      });
    });
  });
  return errors;
}

/**
 * Validate a parsed candidate, throwing on the first invalid aspect. The
 * durable and wire boundaries share this authority so a malformed result
 * never reaches the UI as valid.
 *
 * @param value - the parsed JSON candidate.
 * @returns the validated result.
 * @throws {Error} naming the first invalid aspect.
 */
export function validateAssistResult(value: unknown): AssistResult {
  const errors = collectAssistErrors(value);
  if (errors.length > 0) throw new Error(errors[0]);
  return value as AssistResult;
}

/**
 * Locate the first balanced JSON object in a string, skipping surrounding
 * prose and markdown fences. Returns the substring, or null when no balanced
 * object exists.
 *
 * @param text - raw model output.
 * @returns the candidate JSON object text, or null.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parse raw model text into a validated result, or a repair-needed outcome
 * carrying every validation error. Strict parsing comes first; a lenient
 * recovery (fence stripping / balanced-object extraction) covers models that
 * wrap the JSON in prose.
 *
 * @param text - raw assembled model output.
 * @returns the parse outcome.
 */
export function parseAssistText(text: string): AssistParseOutcome {
  const trimmed = text.trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const extracted = extractJsonObject(trimmed);
    if (extracted !== null) {
      try {
        parsed = JSON.parse(extracted);
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null) {
    return { status: 'repair-needed', errors: ['the model response is not a JSON object'] };
  }
  const errors = collectAssistErrors(parsed);
  if (errors.length > 0) return { status: 'repair-needed', errors };
  return { status: 'ok', result: parsed as AssistResult };
}
