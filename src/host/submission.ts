import { randomUUID } from 'node:crypto';
import type { DiscussionCategory, GitHubIdentity, OfficialDestination } from './github.js';

/** Hard cap on the confirm title; GitHub rejects longer titles anyway. */
export const MAX_SUBMISSION_TITLE_CHARS = 256;

/** Hard cap on the confirm Markdown body. */
export const MAX_SUBMISSION_BODY_CHARS = 64 * 1024;

/** One prepared submission: the read-only snapshot a single confirm may mutate. */
export interface PreparedSubmission {
  identity: GitHubIdentity;
  repositoryId: string;
  categories: DiscussionCategory[];
  destination: OfficialDestination;
}

/**
 * In-memory one-shot store of prepared submissions keyed by a random nonce.
 * `take` removes the record atomically before the mutation runs, so one
 * confirmation can never mutate twice and a lost nonce after a reload simply
 * requires re-preparing (a read-only step).
 */
export interface SubmissionStore {
  create(prepared: PreparedSubmission): string;
  take(preparedId: string): PreparedSubmission | null;
}

/** Create the in-memory one-shot prepared-submission store. */
export function createSubmissionStore(): SubmissionStore {
  const records = new Map<string, PreparedSubmission>();
  return {
    create(prepared) {
      const preparedId = randomUUID();
      records.set(preparedId, prepared);
      return preparedId;
    },
    take(preparedId) {
      const record = records.get(preparedId);
      if (record === undefined) return null;
      records.delete(preparedId);
      return record;
    },
  };
}

/** A validated confirm request body. */
export interface ConfirmSubmissionInput {
  preparedId: string;
  title: string;
  body: string;
  categoryId: string;
}

/**
 * Validate a confirm submission body: exactly the four fields, with
 * non-empty title and category and a capped title/body. Anything else fails
 * loud at the wire boundary so the mutation only ever receives reviewed
 * public content.
 *
 * @param body - parsed request body.
 * @returns the validated confirm input.
 * @throws {Error} describing the first invalid aspect.
 */
export function parseConfirmSubmission(body: unknown): ConfirmSubmissionInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be an object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['preparedId', 'title', 'body', 'categoryId'].includes(key)) {
      throw new Error('unsupported key: ' + key);
    }
  }
  const stringField = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') {
      throw new Error('confirm field ' + key + ' must be a string');
    }
    return value;
  };
  const preparedId = stringField('preparedId');
  if (preparedId.trim() === '') throw new Error('confirm field preparedId must not be empty');
  const title = stringField('title');
  if (title.trim() === '') throw new Error('confirm field title must not be empty');
  if (title.length > MAX_SUBMISSION_TITLE_CHARS) {
    throw new Error('confirm field title exceeds the ' + MAX_SUBMISSION_TITLE_CHARS + ' char cap');
  }
  const bodyText = stringField('body');
  if (bodyText.length > MAX_SUBMISSION_BODY_CHARS) {
    throw new Error('confirm field body exceeds the ' + MAX_SUBMISSION_BODY_CHARS + ' char cap');
  }
  const categoryId = stringField('categoryId');
  if (categoryId.trim() === '') throw new Error('confirm field categoryId must not be empty');
  return { preparedId, title, body: bodyText, categoryId };
}
