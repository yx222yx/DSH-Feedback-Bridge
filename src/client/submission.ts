import type { DiscussionCategory, GitHubSubmissionFailureCode, OfficialDestination } from '../host/github.js';
import type { FetchLike } from './types.js';

/** The read-only preparation snapshot returned by the Host submission route. */
export type SubmissionPrepareResult =
  | {
    status: 'ready';
    preparedId: string;
    identity: { login: string };
    categories: DiscussionCategory[];
    destination: OfficialDestination;
  }
  | { status: 'account-selection-required'; accounts: { login: string }[] }
  | { status: 'failed'; code: GitHubSubmissionFailureCode };

/** The confirm outcome: created with the permanent URL, a definite failure, or unknown. */
export type SubmissionConfirmOutcome =
  | { status: 'created'; url: string }
  | { status: 'failed'; code: GitHubSubmissionFailureCode }
  | { status: 'unknown' };

/** Serialized submission transport handle owned by the Client plugin. */
export interface SubmissionTransport {
  /** Read-only: resolve the prepared submission snapshot; the gh provider takes the explicitly selected account. */
  prepare(account?: string): Promise<SubmissionPrepareResult>;
  /** The distinct final confirmation action: create exactly one Discussion. */
  confirm(input: { preparedId: string; title: string; body: string; categoryId: string }): Promise<SubmissionConfirmOutcome>;
}

/**
 * Client submission transport over the same-origin Host route: GET prepares
 * the read-only snapshot and POST performs the single authorized mutation.
 * The payload carries only the prepared nonce and the reviewed public title,
 * body, and category; nothing else leaves the browser through this route.
 *
 * @param options - the submission route URL and an optional fetch-like function.
 * @returns the transport handle.
 */
export function createSubmissionTransport({
  submissionUrl,
  fetchImpl = (typeof fetch === 'function' ? fetch : undefined) as unknown as FetchLike,
}: {
  submissionUrl: string;
  fetchImpl?: FetchLike;
}): SubmissionTransport {
  return {
    prepare(account) {
      const url = account === undefined
        ? submissionUrl
        : submissionUrl + '?account=' + encodeURIComponent(account);
      return fetchImpl(url, { method: 'GET' })
        .then((response) => {
          if (!response.ok) throw new Error('submission prepare failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => data as SubmissionPrepareResult);
    },
    confirm(input) {
      return fetchImpl(submissionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
        .then((response) => {
          if (!response.ok) throw new Error('submission confirm failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => data as SubmissionConfirmOutcome);
    },
  };
}
