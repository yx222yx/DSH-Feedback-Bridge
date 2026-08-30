import type { FetchLike } from './types.js';

/**
 * One immutable local submission record (Issue #11) served by the Host
 * records route: the public title, the permanent Discussion URL, the
 * submission time, and the submission account identity. It carries nothing
 * else — no body, sources, tokens, or diagnostics.
 */
export interface SubmissionRecord {
  id: string;
  title: string;
  url: string;
  submittedAt: string;
  account: string;
}

/** Serialized submission-records transport handle owned by the Client plugin. */
export interface RecordsTransport {
  /** Read the local submission records; records are immutable and read-only. */
  list(): Promise<SubmissionRecord[]>;
}

/**
 * Client records transport over the same-origin Host records route. The GET
 * payload carries only the immutable record list; a malformed or missing
 * records field resolves to an empty list so a broken response never
 * crashes the records panel.
 *
 * @param options - the records route URL and an optional fetch-like function.
 * @returns the transport handle.
 */
export function createRecordsTransport({
  recordsUrl,
  fetchImpl = (typeof fetch === 'function' ? fetch : undefined) as unknown as FetchLike,
}: {
  recordsUrl: string;
  fetchImpl?: FetchLike;
}): RecordsTransport {
  return {
    list() {
      return fetchImpl(recordsUrl, { method: 'GET' })
        .then((response) => {
          if (!response.ok) throw new Error('records load failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => {
          const records = (data as { records?: unknown }).records;
          return Array.isArray(records) ? (records as SubmissionRecord[]) : [];
        });
    },
  };
}
