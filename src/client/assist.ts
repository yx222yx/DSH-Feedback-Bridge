import type { AssistOutcome, AssistRequest, AssistTransport, DraftLanguage, FetchLike } from './types.js';
import { parseAssistText } from '../host/assist-schema.js';

/**
 * Client feedback-assist transport: posts the validated assist request to the
 * same-origin Host route and resolves the discriminated outcome. The request
 * carries only the user-confirmed sources; live conversation content never
 * leaves the browser through this route.
 */

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

/**
 * Build the serialized assist transport over the same-origin assist route.
 *
 * @param options - the assist route URL and an optional fetch-like function.
 * @returns the transport handle.
 */
export function createAssistTransport({
  assistUrl,
  fetchImpl = (typeof fetch === 'function' ? fetch : undefined) as unknown as FetchLike,
}: {
  assistUrl: string;
  fetchImpl?: FetchLike;
}): AssistTransport {
  return {
    run(request) {
      return fetchImpl(assistUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
        .then((response) => {
          if (!response.ok) throw new Error('assist failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => data as AssistOutcome);
    },
  };
}

/**
 * Re-validate a user-repaired raw response locally with the same parse rules
 * the Host uses; no model call is made. Returns the validated result, or the
 * remaining errors for another repair round.
 *
 * @param text - the repaired raw model text.
 * @returns the validation outcome.
 */
export function revalidateRepairText(text: string):
  | { status: 'ok'; result: import('./types.js').AssistSuggestion }
  | { status: 'repair-needed'; errors: string[] } {
  const parsed = parseAssistText(text);
  if (parsed.status === 'ok') return { status: 'ok', result: parsed.result };
  return { status: 'repair-needed', errors: parsed.errors };
}
