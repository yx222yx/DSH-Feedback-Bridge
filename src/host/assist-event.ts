import type { SessionEventMap } from '@deepseek-ai/dsh-session';
import type { FeedbackType } from './draft-store.js';
import type { DraftLanguage } from './feedback-types.js';
import { INSTRUCTION_VERSION, type AssistInput, type AssistOutcome } from './assist.js';

/**
 * Durable log-only record of one feedback-assist model call. It carries the
 * full model-visible envelope (instruction text plus confirmed source text)
 * so the call is reconstructable from the session log, satisfying the DSH
 * model-visible-input logging rule. The event is informational and never
 * enters the conversation surface; raw model responses are not recorded.
 */
export interface AssistEventPayload {
  provider: string;
  model: string;
  instructionVersion: number;
  language: DraftLanguage | null;
  currentType: FeedbackType;
  sourceIds: string[];
  sourcesText: string;
  systemText: string;
  outcome: 'ok' | 'repair-needed' | 'model-failed' | 'no-model-context';
  failureCode?: string;
  at: string;
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Log-only record of one plugin feedback-assist model call, appended by
     * the Host after the call. Carries the full model-visible envelope so the
     * call is reconstructable from the session log. Informational for
     * reconstruction; readers that do not know it skip it safely.
     * @mode emit
     * @param provider - provider route that served the call.
     * @param model - model id that served the call.
     * @param instructionVersion - version of the instruction prompt.
     * @param language - draft submission language, or null when unset.
     * @param currentType - authoritative feedback type at call time.
     * @param sourceIds - confirmed source record ids in input order.
     * @param sourcesText - assembled model-visible source text.
     * @param systemText - assembled instruction text.
     * @param outcome - the assist outcome.
     * @param failureCode - provider failure code, when the call failed.
     * @param at - ISO timestamp of the call.
     */
    'dsh-feedback-bridge/assist': AssistEventPayload;
  }
}

/**
 * Fail loud when a closed-union switch reaches an unhandled member.
 *
 * @param value - the never value that should be unreachable.
 * @returns never.
 */
function assertNever(value: never): never {
  throw new Error('unreachable assist outcome: ' + String(value));
}

/**
 * Build the durable event payload from an assist outcome and its input.
 * The no-model-context outcome records an empty provider/model because no
 * call was dispatched; the envelope is still recorded for the audit trail.
 *
 * @param outcome - the assist outcome.
 * @param input - the validated assist input.
 * @returns the event payload.
 */
export function buildAssistEventPayload(outcome: AssistOutcome, input: AssistInput): AssistEventPayload {
  const common = {
    instructionVersion: INSTRUCTION_VERSION,
    language: input.language,
    currentType: input.currentType,
    sourceIds: input.sources.map((source) => source.id),
    at: new Date().toISOString(),
  };
  switch (outcome.status) {
    case 'ok':
      return {
        ...common,
        outcome: 'ok',
        provider: outcome.provider,
        model: outcome.model,
        sourcesText: outcome.sourcesText,
        systemText: outcome.systemText,
      };
    case 'repair-needed':
      return {
        ...common,
        outcome: 'repair-needed',
        provider: outcome.provider,
        model: outcome.model,
        sourcesText: outcome.sourcesText,
        systemText: outcome.systemText,
      };
    case 'model-failed':
      return {
        ...common,
        outcome: 'model-failed',
        provider: outcome.provider,
        model: outcome.model,
        sourcesText: outcome.sourcesText,
        systemText: outcome.systemText,
        failureCode: outcome.code,
      };
    case 'no-model-context':
      return {
        ...common,
        outcome: 'no-model-context',
        provider: '',
        model: '',
        sourcesText: outcome.sourcesText,
        systemText: outcome.systemText,
      };
    default:
      return assertNever(outcome);
  }
}
