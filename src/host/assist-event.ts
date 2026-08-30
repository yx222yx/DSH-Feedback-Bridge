import type { SessionEventMap } from '@deepseek-ai/dsh-session';
import type { FeedbackType } from './draft-store.js';
import { INSTRUCTION_VERSION, type AssistInput, type AssistLanguage, type AssistOutcome } from './assist.js';

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
  language: AssistLanguage | null;
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
     * Log-only record of one plugin feedback-assist model call. Informational
     * for reconstruction; readers that do not know it skip it safely.
     */
    'dsh-feedback-bridge/assist': AssistEventPayload;
  }
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
  }
}
