import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import type { ConfirmedSourceRecord, FeedbackType } from './draft-store.js';
import { parseAssistText, type AssistResult } from './assist-schema.js';

/**
 * Host feedback-assist pipeline: resolve the current session's model config,
 * build the request from user-confirmed sources only, stream the call through
 * the official ctx.llm seam, and turn raw model text into a validated
 * AssistResult or a repair/materialized failure outcome. The pipeline
 * is dependency-injected so tests drive it with a controllable fake stream.
 */

/** Version of the instruction prompt; bumped on any semantic prompt change. */
export const INSTRUCTION_VERSION = 1;

/** Plugin id used to mark plugin-produced request messages. */
export const PLUGIN_ID = 'dsh-feedback-bridge';

/** Byte cap on the assembled model response; a longer output is truncated. */
export const MAX_ASSIST_RESPONSE_CHARS = 128 * 1024;

/** Draft submission language; absence means the English default. */
export type AssistLanguage = 'zh' | 'en';

/** One feedback-assist request as sent by the Client to the Host route. */
export interface AssistInput {
  sessionId: string;
  language: AssistLanguage | null;
  currentType: FeedbackType;
  sources: ConfirmedSourceRecord[];
}

/** Discriminated outcome of one assist run, returned to the Client. */
export type AssistOutcome =
  | {
    status: 'ok';
    result: AssistResult;
    provider: string;
    model: string;
    sourcesText: string;
    systemText: string;
  }
  | {
    status: 'repair-needed';
    rawText: string;
    errors: string[];
    provider: string;
    model: string;
    sourcesText: string;
    systemText: string;
  }
  | {
    status: 'model-failed';
    code: string;
    message: string;
    provider: string;
    model: string;
    sourcesText: string;
    systemText: string;
  }
  | { status: 'no-model-context'; sourcesText: string; systemText: string };

/** The official model-call seam as the pipeline sees it, injectable for tests. */
export interface AssistDeps {
  /** Resolve the current session's model config, or undefined without one. */
  resolveConfig(sessionId: string): LlmCallConfig | undefined;
  /** Stream one model call; production wires this to ctx.llm.stream. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/** Result of assembling one stream: text plus truncation, or a terminal failure. */
export type StreamAssembleResult =
  | { kind: 'ok'; text: string; truncated: boolean }
  | { kind: 'failed'; code: string; message: string };

/** Build a model-failed outcome with the shared envelope fields. */
function modelFailed(
  code: string,
  message: string,
  config: LlmCallConfig,
  sourcesText: string,
  systemText: string,
): AssistOutcome {
  return {
    status: 'model-failed',
    code,
    message,
    provider: config.provider,
    model: config.model,
    sourcesText,
    systemText,
  };
}

/**
 * Resolve the draft submission language: an explicit selection wins, and
 * English is the default only when the user has not selected one.
 *
 * @param language - the user-selected language, or null/undefined when unset.
 * @returns the effective language.
 */
export function effectiveLanguage(language: AssistLanguage | null | undefined): AssistLanguage {
  return language === 'zh' ? 'zh' : 'en';
}

/**
 * Join confirmed source snapshots into the single model-visible source text.
 * Only these reviewed snapshots enter; nothing derived or unconfirmed is
 * included here.
 *
 * @param sources - confirmed source records in capture order.
 * @returns the assembled source text.
 */
export function assembleSourcesText(sources: readonly ConfirmedSourceRecord[]): string {
  return sources
    .map((source, index) => '[' + (index + 1) + '] (' + source.role + ')\n' + source.text)
    .join('\n\n');
}

/**
 * The plugin-authored instruction prompt. The prose is not asserted by tests;
 * the structured markers (Language:, Current type:, JSON schema) are stable
 * contract fields the request builder and tests rely on.
 *
 * @param language - the effective draft language.
 * @param currentType - the current authoritative feedback type.
 * @param instructionVersion - the prompt version to stamp.
 * @returns the system prompt text.
 */
export function buildAssistSystemPrompt(
  language: AssistLanguage,
  currentType: FeedbackType,
  instructionVersion: number = INSTRUCTION_VERSION,
): string {
  return [
    'You help the user prepare a community feedback draft for DeepSeek Harness. Everything you produce is a suggestion; the user keeps final authority.',
    'Language: ' + language,
    'Current type: ' + currentType,
    'Feedback sources follow in the user message. Use ONLY those sources; never invent conversation content.',
    'Recommend one feedback type from: plugin-request, harness-feature, harness-defect, custom. Explain the recommendation.',
    'List missing but non-mandatory information; omissions must never block the draft.',
    'Draft the title and body fields in the selected language.',
    'Flag likely secrets, personal information, private paths, confidential content, and excessive context. Never rewrite, redact, or delete any user content; findings are advisory only.',
    'Return ONLY one JSON object matching this schema: ' + JSON.stringify({
      type: 'plugin-request|harness-feature|harness-defect|custom',
      typeReason: 'string',
      missingInfo: [{ field: 'title|scenario|gap|desired|context|reproduction|environment|version|workaround|audience', reason: 'string', importance: 'low|medium|high' }],
      draft: { title: 'string', scenario: 'string', gap: 'string', desired: 'string', context: 'string' },
      privacyFindings: [{ kind: 'secret|personal-info|private-path|confidential|excess-context', severity: 'info|warning|critical', quote: 'string', reason: 'string' }],
    }),
    'Instruction version: ' + instructionVersion,
  ].join('\n');
}

/**
 * Build the model request: the system prompt plus one plugin-marked user
 * message carrying the confirmed source snapshots. Config scalars carry over
 * from the session config so the call inherits the user's model selection.
 *
 * @param config - the current session's model config.
 * @param input - the validated assist input.
 * @returns the assembled request.
 */
export function buildAssistRequest(config: LlmCallConfig, input: AssistInput): GenerateOptions {
  const language = effectiveLanguage(input.language);
  const request: GenerateOptions = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.stop !== undefined ? { stop: config.stop } : {}),
    system: buildAssistSystemPrompt(language, input.currentType),
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: 'Feedback sources:\n\n' + assembleSourcesText(input.sources) }],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      }),
    ],
  };
  return request;
}

/**
 * Assemble one model stream into its visible text, applying the response cap
 * and mapping terminal failures to a failed result.
 *
 * @param stream - the chunk stream.
 * @returns the assembled text, or the terminal failure facts.
 */
export async function assembleStreamText(stream: AsyncIterable<StreamChunk>): Promise<StreamAssembleResult> {
  let text = '';
  let truncated = false;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text;
      if (text.length > MAX_ASSIST_RESPONSE_CHARS) {
        text = text.slice(0, MAX_ASSIST_RESPONSE_CHARS);
        truncated = true;
      }
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        return { kind: 'failed', code: chunk.reason.failure.code, message: chunk.reason.failure.message };
      }
      if (chunk.reason.kind === 'max-tokens') truncated = true;
    }
  }
  return { kind: 'ok', text, truncated };
}

/**
 * Run one feedback-assist call and map the stream to a discriminated outcome.
 * Model output is always a suggestion; the user's draft and sources are never
 * touched here.
 *
 * @param deps - injected model-call seam (config resolution + stream).
 * @param input - the validated assist input.
 * @returns the assist outcome.
 */
export async function runAssist(deps: AssistDeps, input: AssistInput): Promise<AssistOutcome> {
  const language = effectiveLanguage(input.language);
  const systemText = buildAssistSystemPrompt(language, input.currentType);
  const sourcesText = assembleSourcesText(input.sources);
  const config = deps.resolveConfig(input.sessionId);
  if (config === undefined) {
    return { status: 'no-model-context', sourcesText, systemText };
  }
  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = deps.stream(buildAssistRequest(config, input));
  } catch (error) {
    return modelFailed('UNKNOWN', (error as Error).message, config, sourcesText, systemText);
  }
  let assembled: StreamAssembleResult;
  try {
    assembled = await assembleStreamText(stream);
  } catch (error) {
    // Adapter failures normally arrive as terminal finish chunks; an error
    // escaping iteration is a consumer/plugin failure and maps to the same
    // distinct model-failed state so the response never hangs.
    return modelFailed('UNKNOWN', (error as Error).message, config, sourcesText, systemText);
  }
  if (assembled.kind === 'failed') {
    return modelFailed(assembled.code, assembled.message, config, sourcesText, systemText);
  }
  if (assembled.truncated) {
    return {
      status: 'repair-needed',
      rawText: assembled.text,
      errors: ['the model response was truncated before it could be validated'],
      provider: config.provider,
      model: config.model,
      sourcesText,
      systemText,
    };
  }
  const parsed = parseAssistText(assembled.text);
  if (parsed.status === 'ok') {
    return {
      status: 'ok',
      result: parsed.result,
      provider: config.provider,
      model: config.model,
      sourcesText,
      systemText,
    };
  }
  return {
    status: 'repair-needed',
    rawText: assembled.text,
    errors: parsed.errors,
    provider: config.provider,
    model: config.model,
    sourcesText,
    systemText,
  };
}
