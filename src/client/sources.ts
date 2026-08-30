import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import type { AssistantBlock, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client';

/**
 * Client-side feedback-source model. The wire record contract mirrors the
 * Host's ConfirmedSourceRecord (src/host/draft-store.ts); the Host validates
 * it at the durable-file and route boundaries, so this face only shapes the
 * capture payload.
 */

/** Material class of one feedback source candidate. */
export type SourceKind = 'message' | 'tool-result' | 'diagnostic';

/** Speaker or producer role of one feedback source candidate. */
export type SourceRole = 'user' | 'assistant' | 'steering' | 'context' | 'tool' | 'error' | 'session';

/** Lifecycle status of one source within the current workspace session. */
export type SourceStatus = 'candidate' | 'recommended' | 'confirmed' | 'removed';

/** Row preview cap, in characters. */
export const SOURCE_PREVIEW_CHARS = 400;

/** Byte cap on one confirmed source's captured text snapshot; matches the Host cap. */
export const SOURCE_CAPTURE_CAP = 16 * 1024;

/** Maximum candidates the panel lists (newest first, diagnostics included). */
export const MAX_CANDIDATES = 50;

/**
 * One derived source candidate. Candidates are always derived from the live
 * conversation snapshot; only confirmed candidates become persisted records.
 * `errorSignal` is derivation-internal (drives recommendation) and never
 * persisted. The display label is locale-owned at the render site, so it is
 * not part of the candidate shape.
 */
export interface FeedbackSourceCandidate {
  id: string;
  itemId: string;
  sessionId: string;
  kind: SourceKind;
  role: SourceRole;
  preview: string;
  fullText: string;
  recommended: boolean;
  recommendReason: 'recent' | 'error' | 'tool-error' | 'turn-error' | 'session' | null;
  sensitive: boolean;
  errorSignal: boolean;
}

/** One user-confirmed feedback source persisted with the draft (Host contract mirror). */
export interface ConfirmedSourceRecord {
  id: string;
  sessionId: string;
  kind: SourceKind;
  role: SourceRole;
  label: string;
  text: string;
  truncated: boolean;
  sensitive: boolean;
  capturedAt: string;
}

/** Session facts folded into the diagnostics candidate. */
export interface SourceDerivationContext {
  sessionId: string;
  title?: string;
  cwd?: string;
  agentPreset?: string;
  dshVersion?: string | null;
}

/** Small documented keyword set driving the defect-content recommendation. */
const DEFECT_KEYWORDS = [
  'error',
  'failed',
  'failure',
  'bug',
  'exception',
  'crash',
  '报错',
  '失败',
  '错误',
  '缺陷',
  '异常',
  '无法',
];

/** Advisory-only secret markers; matches never block or rewrite content. */
const SENSITIVE_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /api[_-]?key/i,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bauthorization\b/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const encoder = new TextEncoder();

/**
 * UTF-8 byte length of a string; the capture cap is byte-based so multi-byte
 * text counts honestly against the persisted-file budget.
 *
 * @param text - the string to measure.
 * @returns the encoded byte count.
 */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Whether text contains a known credential-like marker. Advisory only: the
 * result flags a row for the user, it never selects, blocks, or rewrites.
 *
 * @param text - the text to scan.
 * @returns true when any marker matches.
 */
export function sensitiveMarkerHit(text: string): boolean {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Row preview: the first {@link SOURCE_PREVIEW_CHARS} characters plus an
 * ellipsis when longer.
 *
 * @param text - the full text.
 * @returns the preview string.
 */
export function sourcePreview(text: string): string {
  return text.length > SOURCE_PREVIEW_CHARS
    ? text.slice(0, SOURCE_PREVIEW_CHARS) + '…'
    : text;
}

/**
 * Capture a reviewed text snapshot: full text when it fits the byte cap,
 * otherwise the longest character prefix that fits, marked truncated.
 *
 * @param text - the full reviewed text.
 * @returns the snapshot text and its truncation flag.
 */
export function captureSourceText(text: string): { text: string; truncated: boolean } {
  if (utf8ByteLength(text) <= SOURCE_CAPTURE_CAP) return { text, truncated: false };
  return { text: truncateToBytes(text, SOURCE_CAPTURE_CAP), truncated: true };
}

/**
 * Longest character prefix of text whose UTF-8 encoding fits the byte cap.
 *
 * @param text - the full text.
 * @param cap - maximum encoded bytes.
 * @returns the fitting prefix.
 */
function truncateToBytes(text: string, cap: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8ByteLength(text.slice(0, mid)) <= cap) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/**
 * Text of a core content block array: only visible text blocks, joined with
 * blank lines. Reasoning, images, tool calls, and unknown blocks never enter
 * source text.
 *
 * @param blocks - core content blocks.
 * @returns the joined visible text.
 */
function contentText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text);
  }
  return parts.join('\n\n');
}

/**
 * Text of an assistant message's UI-classified blocks: visible text blocks
 * only; reasoning and tool-call cards are excluded from source text.
 *
 * @param blocks - assistant message blocks.
 * @returns the joined visible text.
 */
function assistantBlocksText(blocks: readonly AssistantBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'text' && block.text.trim() !== '') parts.push(block.text);
  }
  return parts.join('\n\n');
}

/**
 * Map one conversation node to a source candidate, or null when the node
 * kind is not feedback material (compaction markers, commands, retries).
 *
 * @param node - one conversation node.
 * @param sessionId - owning session id.
 * @returns the candidate or null.
 */
function nodeCandidate(node: ConversationSnapshot['nodes'][number], sessionId: string): FeedbackSourceCandidate | null {
  let role: SourceRole;
  let kind: SourceKind;
  let itemId: string;
  let fullText: string;
  let errorSignal = false;
  switch (node.kind) {
    case 'user':
      role = 'user';
      kind = 'message';
      itemId = 'node:user:' + node.seq;
      fullText = contentText(node.content);
      break;
    case 'steering':
      role = 'steering';
      kind = 'message';
      itemId = 'node:steering:' + node.seq;
      fullText = contentText(node.content);
      break;
    case 'context':
      role = 'context';
      kind = 'message';
      itemId = 'node:context:' + node.seq;
      fullText = contentText(node.content);
      break;
    case 'assistant':
      role = 'assistant';
      kind = 'message';
      itemId = 'node:assistant:' + node.seq;
      fullText = assistantBlocksText(node.blocks);
      break;
    case 'tool-result':
      role = 'tool';
      kind = 'tool-result';
      itemId = 'tool:' + node.callId;
      fullText = contentText(node.content);
      errorSignal = node.isError === true;
      break;
    case 'turn-error':
      role = 'error';
      kind = 'diagnostic';
      itemId = 'error:' + node.seq;
      fullText = node.message + (node.code !== undefined ? '\ncode: ' + node.code : '');
      errorSignal = true;
      break;
    case 'turn-max-tokens':
      role = 'error';
      kind = 'diagnostic';
      itemId = 'error:' + node.seq;
      fullText = 'The turn reached the output token cap.';
      errorSignal = true;
      break;
    default:
      return null;
  }
  return {
    id: sessionId + ':' + itemId,
    itemId,
    sessionId,
    kind,
    role,
    preview: sourcePreview(fullText),
    fullText,
    recommended: false,
    recommendReason: null,
    sensitive: sensitiveMarkerHit(fullText),
    errorSignal,
  };
}

/**
 * Compose the session-diagnostics candidate text from the derivation context.
 *
 * @param context - session facts.
 * @returns the diagnostics text.
 */
function sessionDiagnosticsText(context: SourceDerivationContext): string {
  const parts: string[] = [];
  if (context.title !== undefined && context.title !== '') parts.push('标题：' + context.title);
  if (context.cwd !== undefined && context.cwd !== '') parts.push('工作目录：' + context.cwd);
  if (context.agentPreset !== undefined && context.agentPreset !== '') parts.push('Agent 预设：' + context.agentPreset);
  if (context.dshVersion !== undefined && context.dshVersion !== null && context.dshVersion !== '') {
    parts.push('DSH 版本：' + context.dshVersion);
  }
  parts.push('会话 ID：' + context.sessionId);
  return parts.join('\n');
}

/**
 * Derive the candidate list from the current conversation window: one
 * diagnostics block on top, then in-window messages and tool results newest
 * first, capped at {@link MAX_CANDIDATES}. Nothing here is selected: the
 * caller must confirm each candidate before it can feed draft preparation.
 *
 * @param snapshot - the conversation snapshot (only nodes and openState are
 * read).
 * @param context - session facts for the diagnostics block.
 * @returns the derived candidates, or an empty array outside an open window
 * or with no message material.
 */
export function deriveSourceCandidates(
  snapshot: Pick<ConversationSnapshot, 'nodes' | 'openState'>,
  context: SourceDerivationContext,
): FeedbackSourceCandidate[] {
  if (snapshot.openState !== 'open') return [];
  const messageCandidates: FeedbackSourceCandidate[] = [];
  for (const node of snapshot.nodes) {
    const candidate = nodeCandidate(node, context.sessionId);
    if (candidate !== null) messageCandidates.push(candidate);
  }
  if (messageCandidates.length === 0) return [];
  messageCandidates.reverse();
  const diagnostics: FeedbackSourceCandidate = {
    id: context.sessionId + ':session:meta',
    itemId: 'session:meta',
    sessionId: context.sessionId,
    kind: 'diagnostic',
    role: 'session',
    preview: sourcePreview(sessionDiagnosticsText(context)),
    fullText: sessionDiagnosticsText(context),
    recommended: false,
    recommendReason: null,
    sensitive: sensitiveMarkerHit(sessionDiagnosticsText(context)),
    errorSignal: false,
  };
  return [diagnostics, ...messageCandidates].slice(0, MAX_CANDIDATES);
}

/**
 * Apply the deterministic v0.1 recommendation rules: the session diagnostics
 * block, the latest user/steering message, content matching the defect
 * keyword set, and error-signal tool results or turn errors. Recommendations
 * are proposals only; confirmation is the only way into the workflow.
 *
 * @param candidates - derived candidates.
 * @returns new candidates with recommendation flags set.
 */
export function applyRecommendations(candidates: readonly FeedbackSourceCandidate[]): FeedbackSourceCandidate[] {
  const result = candidates.map((candidate) => ({
    ...candidate,
    recommended: false,
    recommendReason: null,
  })) as FeedbackSourceCandidate[];
  for (const candidate of result) {
    if (candidate.role === 'session') {
      candidate.recommended = true;
      candidate.recommendReason = 'session';
    }
  }
  const latest = result.find((candidate) => (candidate.role === 'user' || candidate.role === 'steering') && candidate.fullText.trim() !== '');
  if (latest !== undefined) {
    latest.recommended = true;
    latest.recommendReason = 'recent';
  }
  for (const candidate of result) {
    if (candidate.recommended) continue;
    if (candidate.errorSignal) {
      candidate.recommended = true;
      candidate.recommendReason = candidate.role === 'tool' ? 'tool-error' : 'turn-error';
    }
  }
  for (const candidate of result) {
    if (candidate.recommended) continue;
    if (DEFECT_KEYWORDS.some((keyword) => candidate.fullText.toLowerCase().includes(keyword))) {
      candidate.recommended = true;
      candidate.recommendReason = 'error';
    }
  }
  return result;
}

/**
 * Turn a confirmed candidate into the persisted record, capturing the
 * reviewed text snapshot at confirmation time.
 *
 * @param candidate - the candidate the user confirmed.
 * @param capturedAt - ISO timestamp of the confirmation.
 * @param label - locale-owned display label captured with the record.
 * @returns the persisted record.
 */
export function confirmSourceCandidate(candidate: FeedbackSourceCandidate, capturedAt: string, label: string): ConfirmedSourceRecord {
  const captured = captureSourceText(candidate.fullText);
  return {
    id: candidate.id,
    sessionId: candidate.sessionId,
    kind: candidate.kind,
    role: candidate.role,
    label,
    text: captured.text,
    truncated: captured.truncated,
    sensitive: candidate.sensitive,
    capturedAt,
  };
}

/**
 * Remove one confirmed source by id.
 *
 * @param records - current confirmed records.
 * @param id - the record id to remove.
 * @returns the remaining records.
 */
export function removeSource(records: readonly ConfirmedSourceRecord[], id: string): ConfirmedSourceRecord[] {
  return records.filter((record) => record.id !== id);
}

/**
 * The reviewed snapshot text a confirmed source contributes to a public
 * field when quoted. Only this text is ever copied into the draft fields.
 *
 * @param record - a confirmed source.
 * @returns its captured text.
 */
export function quoteSourceText(record: ConfirmedSourceRecord): string {
  return record.text;
}

