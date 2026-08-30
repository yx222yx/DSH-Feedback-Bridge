import { ASSIST_PATH, DRAFT_PATH, SIMILARITY_PATH, STATUS_PATH, SUBMISSION_PATH } from './constants.js';

/**
 * Resolve the same-origin Host status route under the document base URL.
 *
 * @returns the status route pathname.
 */
export function statusUrl(): string {
  if (typeof document === 'undefined') return STATUS_PATH;
  return new URL('dsh-feedback-bridge/status', document.baseURI).pathname;
}

/**
 * Resolve the same-origin Host draft route under the document base URL.
 *
 * @returns the draft route pathname.
 */
export function draftUrl(): string {
  if (typeof document === 'undefined') return DRAFT_PATH;
  return new URL('dsh-feedback-bridge/draft', document.baseURI).pathname;
}

/**
 * Resolve the same-origin Host assist route under the document base URL.
 *
 * @returns the assist route pathname.
 */
export function assistUrl(): string {
  if (typeof document === 'undefined') return ASSIST_PATH;
  return new URL('dsh-feedback-bridge/assist', document.baseURI).pathname;
}

/**
 * Resolve the same-origin Host similarity route under the document base URL.
 *
 * @returns the similarity route pathname.
 */
export function similarityUrl(): string {
  if (typeof document === 'undefined') return SIMILARITY_PATH;
  return new URL('dsh-feedback-bridge/similarity', document.baseURI).pathname;
}

/**
 * Resolve the same-origin Host submission route under the document base URL.
 *
 * @returns the submission route pathname.
 */
export function submissionUrl(): string {
  if (typeof document === 'undefined') return SUBMISSION_PATH;
  return new URL('dsh-feedback-bridge/submission', document.baseURI).pathname;
}