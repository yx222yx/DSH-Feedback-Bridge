import { DRAFT_PATH, STATUS_PATH } from './constants.js';

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
