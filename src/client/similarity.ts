import type { SimilarityOutcome } from '../host/similarity.js';
import type { FetchLike, FeedbackType, SimilarityRequest, SimilarityTransport } from './types.js';

/**
 * Client similarity transport: posts the minimal feedback intent to the
 * same-origin Host route and resolves the per-source outcome. The payload
 * carries only the three intent fields plus the feedback type and language;
 * confirmed sources and live conversation content never leave the browser
 * through this route. The caller may pass an AbortSignal so a stale check can
 * be cancelled.
 */

/**
 * Build the serialized similarity transport over the same-origin route.
 *
 * @param options - the similarity route URL and an optional fetch-like function.
 * @returns the transport handle.
 */
export function createSimilarityTransport({
  similarityUrl,
  fetchImpl = (typeof fetch === 'function' ? fetch : undefined) as unknown as FetchLike,
}: {
  similarityUrl: string;
  fetchImpl?: FetchLike;
}): SimilarityTransport {
  return {
    run(input, signal) {
      return fetchImpl(similarityUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        ...(signal !== undefined ? { signal } : {}),
      })
        .then((response) => {
          if (!response.ok) throw new Error('similarity failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => data as SimilarityOutcome);
    },
  };
}

/**
 * The normalized signature of the current feedback intent: null until
 * scenario, gap, and desired are all non-empty, then a case/whitespace-normal
 * string that also includes the feedback type. The workspace uses it both to
 * gate the check and to skip re-searching an unchanged intent.
 *
 * @param intent - the current intent fields.
 * @returns the signature, or null when the minimum intent is absent.
 */
export function similaritySignature(intent: { scenario: string; gap: string; desired: string; type: FeedbackType }): string | null {
  const scenario = intent.scenario.trim();
  const gap = intent.gap.trim();
  const desired = intent.desired.trim();
  if (scenario === '' || gap === '' || desired === '') return null;
  return JSON.stringify([scenario.toLowerCase(), gap.toLowerCase(), desired.toLowerCase(), intent.type]);
}
