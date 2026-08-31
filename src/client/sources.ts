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

/** Row preview cap, in characters; rows stay compact so a crowded conversation does not dominate the panel. */
export const SOURCE_PREVIEW_CHARS = 120;

/**
 * Byte cap on one confirmed source's captured text snapshot. Mirrors the Host
 * constant MAX_SOURCE_TEXT (src/host/draft-store.ts); the Host is the
 * authoritative validator at the wire and durable-file boundaries.
 */
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
  /** Transient flag (never persisted): the candidate is one full exchange, not a single interaction row. */
  exchange?: boolean;
  /** Transient: which member carried the error signal, for a precise recommendation reason. */
  errorSource?: 'tool' | 'turn';
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

/**
 * Locale-owned copy the source model needs when composing candidate text:
 * the diagnostics block labels and the fixed error sentences. The workspace
 * builds this from the locale dictionaries, so no plugin-invented string is
 * hardcoded in the pure module.
 */
export interface SourceCopy {
  diagTitle: string;
  diagCwd: string;
  diagPreset: string;
  diagVersion: string;
  diagSession: string;
  turnMaxTokens: string;
  errorCode: string;
  /** Role headers for exchange source text, e.g. 'User' / 'Assistant'. */
  roleUser: string;
  roleAssistant: string;
  roleTool: string;
  roleError: string;
  roleSteering: string;
  roleContext: string;
}

/** Session facts folded into the diagnostics candidate. */
export interface SourceDerivationContext {
  sessionId: string;
  title?: string;
  cwd?: string;
  agentPreset?: string;
  dshVersion?: string | null;
  /** Locale-owned labels for the diagnostics block and error sentences. */
  copy: SourceCopy;
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

/** One node's contribution to an exchange source: a role header plus its visible text. */
function exchangeNodeText(node: ConversationSnapshot['nodes'][number], copy: SourceCopy): string {
  switch (node.kind) {
    case 'user':
      return copy.roleUser + ':\n' + contentText(node.content);
    case 'steering':
      return copy.roleSteering + ':\n' + contentText(node.content);
    case 'context':
      return copy.roleContext + ':\n' + contentText(node.content);
    case 'assistant':
      return copy.roleAssistant + ':\n' + assistantBlocksText(node.blocks);
    case 'tool-result':
      return copy.roleTool + ':\n' + contentText(node.content);
    case 'turn-error':
      return copy.roleError + ':\n' + node.message + (node.code !== undefined ? '\n' + copy.errorCode + node.code : '');
    case 'turn-max-tokens':
      return copy.roleError + ':\n' + copy.turnMaxTokens;
    default:
      return '';
  }
}

/** Whether a node carries an error signal for recommendation. */
function nodeErrorSignal(node: ConversationSnapshot['nodes'][number]): 'tool' | 'turn' | null {
  switch (node.kind) {
    case 'tool-result':
      return node.isError === true ? 'tool' : null;
    case 'turn-error':
    case 'turn-max-tokens':
      return 'turn';
    default:
      return null;
  }
}

/** A grouped exchange: one user/steering prompt plus every node until the next prompt. */
interface ExchangeGroup {
  startSeq: number;
  role: SourceRole;
  parts: string[];
  errorSource: 'tool' | 'turn' | null;
  sensitive: boolean;
}

/**
 * Group conversation nodes into exchanges: an exchange starts at a user or
 * steering prompt and runs through the model's complete output (assistant
 * reply, tool results, turn errors) until the next prompt. Leading context
 * nodes attach to the first exchange. This makes one citable feedback source
 * a full exchange instead of every individual interaction row.
 *
 * @param nodes - conversation nodes in order.
 * @param copy - locale-owned labels.
 * @returns the grouped exchanges.
 */
function groupExchanges(nodes: readonly ConversationSnapshot['nodes'][number][], copy: SourceCopy): ExchangeGroup[] {
  const groups: ExchangeGroup[] = [];
  let current: ExchangeGroup | null = null;
  for (const node of nodes) {
    if (node.kind === 'user' || node.kind === 'steering') {
      const opening = exchangeNodeText(node, copy);
      current = {
        startSeq: node.seq,
        role: node.kind === 'user' ? 'user' : 'steering',
        parts: opening === '' ? [] : [opening],
        errorSource: null,
        sensitive: sensitiveMarkerHit(opening),
      };
      groups.push(current);
    } else if (current !== null) {
      const text = exchangeNodeText(node, copy);
      if (text !== '') {
        current.parts.push(text);
        const error = nodeErrorSignal(node);
        if (error !== null && current.errorSource === null) current.errorSource = error;
        if (sensitiveMarkerHit(text)) current.sensitive = true;
      }
    }
  }
  return groups;
}

/**
 * Compose the session-diagnostics candidate text from the derivation context.
 *
 * @param context - session facts.
 * @returns the diagnostics text.
 */
function sessionDiagnosticsText(context: SourceDerivationContext): string {
  const parts: string[] = [];
  const copy = context.copy;
  if (context.title !== undefined && context.title !== '') parts.push(copy.diagTitle + context.title);
  if (context.cwd !== undefined && context.cwd !== '') parts.push(copy.diagCwd + context.cwd);
  if (context.agentPreset !== undefined && context.agentPreset !== '') parts.push(copy.diagPreset + context.agentPreset);
  if (context.dshVersion !== undefined && context.dshVersion !== null && context.dshVersion !== '') {
    parts.push(copy.diagVersion + context.dshVersion);
  }
  parts.push(copy.diagSession + context.sessionId);
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
  const groups = groupExchanges(snapshot.nodes, context.copy);
  if (groups.length === 0) return [];
  const exchanges: FeedbackSourceCandidate[] = groups.map((group) => {
    const fullText = group.parts.join('\n\n');
    return {
      id: context.sessionId + ':exchange:' + group.startSeq,
      itemId: 'exchange:' + group.startSeq,
      sessionId: context.sessionId,
      kind: 'message',
      role: group.role,
      preview: sourcePreview(fullText),
      fullText,
      recommended: false,
      recommendReason: null,
      sensitive: group.sensitive || sensitiveMarkerHit(fullText),
      errorSignal: group.errorSource !== null,
      exchange: true,
      errorSource: group.errorSource ?? undefined,
    };
  });
  exchanges.reverse();
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
  return [diagnostics, ...exchanges].slice(0, MAX_CANDIDATES);
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
      candidate.recommendReason = candidate.errorSource === 'tool' || candidate.role === 'tool' ? 'tool-error' : 'turn-error';
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

