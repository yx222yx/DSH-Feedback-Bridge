import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { SessionId } from '@deepseek-ai/dsh-session';
import { assistEnvelope, runAssist, type AssistInput } from './assist.js';
import { buildAssistEventPayload } from './assist-event.js';
import {
  normalizeSimilarityConfig,
  runSimilarity,
  type SimilarityConfig,
  type SimilarityInput,
} from './similarity.js';
import { createGitHubService, normalizeGitHubConfig, type GitHubConfig, type GitHubService } from './github.js';
import { createGhCli, createGhRun } from './gh-cli.js';
import {
  createSubmissionStore,
  parseConfirmSubmission,
  type ConfirmSubmissionInput,
  type SubmissionStore,
} from './submission.js';
import {
  assertFeedbackType,
  assertLanguage,
  draftFilePath,
  load,
  remove,
  save,
  validateSources,
  FEEDBACK_TYPES,
  type ConfirmedSourceRecord,
  type DraftFields,
  type DraftLanguage,
  type FeedbackType,
} from './draft-store.js';

const name = 'dsh-feedback-bridge';
const inject = ['webServer', 'sessions', 'llm'];
export { name, inject };

const STATUS_PATH = '/dsh-feedback-bridge/status';
const DRAFT_PATH = '/dsh-feedback-bridge/draft';
const ASSIST_PATH = '/dsh-feedback-bridge/assist';
const SIMILARITY_PATH = '/dsh-feedback-bridge/similarity';
const SUBMISSION_PATH = '/dsh-feedback-bridge/submission';

/** Hard cap on the draft request body: a draft is five text fields. */
const MAX_DRAFT_BODY_BYTES = 1 << 20;

/** Hard cap on one similarity intent field; the config cap further trims what reaches the sources. */
export const MAX_SIMILARITY_FIELD_CHARS = 64 * 1024;

/** Package manifest fields the plugin reads at load. */
interface ManifestShape {
  version?: unknown;
  dsh?: { compatibility?: { dsh?: unknown } };
}

/**
 * Read this package's own manifest once. `import.meta.url` lives inside
 * `lib/index.js`, so the package root is one directory up.
 */
const manifestUrl = new URL('../package.json', import.meta.url);
const manifest: ManifestShape = JSON.parse(readFileSync(manifestUrl, 'utf8'));

/**
 * Extract the supported DSH version range from a parsed package manifest.
 *
 * @param sourceManifest - parsed package.json object.
 * @returns the non-empty compatibility range string.
 * @throws {Error} when `dsh.compatibility.dsh` is missing or empty.
 */
export function compatibilityRangeOf(sourceManifest: ManifestShape | null | undefined): string {
  const range = sourceManifest?.dsh?.compatibility?.dsh;
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error(
      'dsh-feedback-bridge: package.json must declare a non-empty dsh.compatibility.dsh range',
    );
  }
  return range;
}

const compatibilityRange = compatibilityRangeOf(manifest);

/** Parsed semver-shaped version parts. */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/**
 * Parse a semver-shaped version into comparable parts.
 *
 * @param raw - version string such as `0.1.1-rc.2`.
 * @returns parsed version parts, or null when the string is not semver-shaped.
 */
function parseVersion(raw: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(raw).trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compare two parsed versions; returns negative, zero, or positive.
 *
 * @param a - left parsed version.
 * @param b - right parsed version.
 * @returns comparison delta.
 */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const delta = a[key] - b[key];
    if (delta !== 0) return delta;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compare two semver prerelease labels.
 *
 * @param a - left prerelease label.
 * @param b - right prerelease label.
 * @returns comparison delta.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumber = /^\d+$/.test(l);
    const rNumber = /^\d+$/.test(r);
    if (lNumber && rNumber) {
      const delta = Number(l) - Number(r);
      if (delta !== 0) return delta;
    } else if (lNumber) {
      return -1;
    } else if (rNumber) {
      return 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Parse the supported `>=min <max` range shape.
 *
 * @param range - range string such as `>=0.1.1-rc.2 <0.2.0`.
 * @returns lower and upper bounds.
 */
function parseRange(range: string): { min: string | null; max: string | null } {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  let min: string | null = null;
  let max: string | null = null;
  for (const part of parts) {
    if (part.startsWith('>=')) min = part.slice(2);
    else if (part.startsWith('<')) max = part.slice(1);
  }
  return { min, max };
}

/**
 * Test whether a DSH version satisfies the supported range.
 *
 * @param version - DSH version string to test.
 * @param range - supported range; defaults to this package's declared range.
 * @returns true when the version is inside the range.
 */
export function isDshVersionCompatible(version: string, range: string = compatibilityRange): boolean {
  const parsed = parseVersion(version);
  const bounds = parseRange(range);
  if (parsed === null) return false;
  if (bounds.min !== null) {
    const min = parseVersion(bounds.min);
    if (min !== null && compareParsed(parsed, min) < 0) return false;
  }
  if (bounds.max !== null) {
    const max = parseVersion(bounds.max);
    if (max !== null && compareParsed(parsed, max) >= 0) return false;
  }
  return true;
}

/**
 * Resolve the running DeepSeek Harness version without importing Harness
 * internals. The env override keeps the check testable from a fake-backed
 * test; under the real CLI the bin path is the source of truth.
 *
 * @returns detected DSH version, or null when the CLI cannot be identified.
 */
export function detectDshVersion(): string | null {
  if (process.env.DSH_VERSION !== undefined && process.env.DSH_VERSION !== '') {
    return process.env.DSH_VERSION;
  }
  const invoked = process.argv[1];
  if (invoked === undefined) return null;

  let real: string;
  try {
    real = realpathSync(invoked);
  } catch (error) {
    // realpathSync fails when argv[1] is not a resolvable filesystem path
    // (for example in tests or a custom launcher); there is then no version
    // to detect, and assertCompatibleDsh turns that into a loud failure.
    void error;
    return null;
  }

  if (!/(?:^|[\\/])@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(real)) return null;

  try {
    const manifestContent = readFileSync(new URL('../package.json', pathToFileURL(real)), 'utf8');
    const parsed = JSON.parse(manifestContent) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch (error) {
    // readFileSync or JSON.parse fails only when the DSH CLI layout differs
    // from the expected package.json anchor or its manifest is unreadable;
    // null propagates to assertCompatibleDsh for a loud error.
    void error;
    return null;
  }
}

/**
 * Reject incompatible or undetectable DSH versions before any route is
 * registered.
 *
 * @param version - DSH version to check; defaults to detectDshVersion().
 * @returns void.
 * @throws {Error} when the version is outside the supported range or cannot
 * be detected.
 */
export function assertCompatibleDsh(version: string | null = detectDshVersion()): void {
  if (version === null) {
    throw new Error(
      `dsh-feedback-bridge: unable to detect DeepSeek Harness version; this bundle supports ${compatibilityRange}.`,
    );
  }
  if (!isDshVersionCompatible(version)) {
    throw new Error(
      `dsh-feedback-bridge: incompatible DeepSeek Harness version ${version}; this bundle supports ${compatibilityRange}.`,
    );
  }
}

/**
 * Read this package's version for the status payload.
 *
 * @returns package version string.
 */
export function ownVersion(): string {
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

/** Host status payload served to the Client. */
export interface StatusPayload {
  name: string;
  status: string;
  version: string;
  dshVersion: string | null;
  compatible: boolean | null;
}

/**
 * Build the host status payload served to the Client.
 *
 * @param dshVersion - detected DSH version; defaults to detectDshVersion().
 * @returns status payload object.
 */
export function statusPayload(dshVersion: string | null = detectDshVersion()): StatusPayload {
  return {
    name: 'DSH Feedback Bridge',
    status: 'loaded',
    version: ownVersion(),
    dshVersion,
    compatible: dshVersion === null ? null : isDshVersionCompatible(dshVersion),
  };
}

/**
 * Write a JSON response with a no-store cache policy.
 *
 * @param response - the server response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable payload.
 * @param extraHeaders - additional response headers.
 * @returns void.
 */
function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

/** Error carrying an HTTP status code for wire-boundary failures. */
type HttpError = Error & { statusCode: number };

/** Create an error with a wire-boundary HTTP status code. */
function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

/**
 * Read a request body as JSON with a hard byte cap. The error thrown carries
 * a statusCode of 413 when the cap is exceeded.
 *
 * @param request - the incoming request.
 * @returns the parsed JSON value.
 * @throws {HttpError} with statusCode 400 for empty or malformed JSON, 413 for
 * an oversized body.
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_DRAFT_BODY_BYTES) {
      throw httpError(413, 'draft request body exceeds the size limit');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw httpError(400, 'request body must be JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'request body must be valid JSON');
  }
}

/** A validated draft write: remove, or save with five string fields, confirmed sources, and the feedback type/language. */
type DraftWrite =
  | { action: 'remove'; draft: null }
  | {
    action: 'save';
    draft: DraftFields & { sources: ConfirmedSourceRecord[] };
    type: FeedbackType;
    language?: DraftLanguage;
  };

/**
 * Validate a draft write body: an object with action `save` (plus exactly
 * the five string fields and an optional validated sources array) or action
 * `remove`. Anything else is rejected so unexpected actions and shapes fail
 * loud at the wire boundary.
 *
 * @param body - parsed request body.
 * @returns the validated action and draft fields.
 * @throws {Error} describing the first invalid aspect.
 */
function parseDraftWrite(body: unknown): DraftWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be an object');
  }
  const record = body as Record<string, unknown>;
  if (record.action === 'remove') return { action: 'remove', draft: null };
  if (record.action !== 'save') {
    throw new Error('unsupported action: ' + String(record.action));
  }
  const draft = record.draft;
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('draft must be an object');
  }
  const expected = ['title', 'scenario', 'gap', 'desired', 'context'];
  const allowed = [...expected, 'sources', 'type', 'language'];
  const keys = Object.keys(draft);
  if (
    keys.some((key) => !allowed.includes(key))
    || expected.some((key) => !(key in draft) || typeof (draft as Record<string, unknown>)[key] !== 'string')
  ) {
    throw new Error('draft must contain exactly the five string fields (title, scenario, gap, desired, context) plus optional sources, type, and language');
  }
  const sources = 'sources' in draft ? validateSources((draft as Record<string, unknown>).sources) : [];
  const candidate = draft as Record<string, unknown>;
  const type = 'type' in candidate ? candidate.type : 'custom';
  assertFeedbackType(type);
  const language = 'language' in candidate ? candidate.language : undefined;
  assertLanguage(language);
  return {
    action: 'save',
    draft: { ...(draft as DraftFields), sources },
    type,
    ...(language !== undefined ? { language } : {}),
  };
}

/**
 * Validate an assist request body: a non-empty session id, an optional
 * language (zh/en/absent), a current feedback type, and validated confirmed
 * sources. Anything else fails loud at the wire boundary so the model call
 * only ever receives user-confirmed material.
 *
 * @param body - parsed request body.
 * @returns the validated assist input.
 * @throws {Error} describing the first invalid aspect.
 */
function parseAssistRequest(body: unknown): AssistInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be an object');
  }
  const record = body as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') {
    throw new Error('sessionId must be a non-empty string');
  }
  const language = record.language ?? null;
  if (language !== null && language !== 'zh' && language !== 'en') {
    throw new Error('language must be zh, en, or absent');
  }
  if (!(FEEDBACK_TYPES as readonly string[]).includes(record.currentType as string)) {
    throw new Error('currentType must be one of: ' + FEEDBACK_TYPES.join(', '));
  }
  const sources = validateSources(record.sources);
  return {
    sessionId: record.sessionId,
    language: language as 'zh' | 'en' | null,
    currentType: record.currentType as FeedbackType,
    sources,
  };
}

/**
 * Handle one request on the assist route. POST runs one feedback-assist model
 * call through the current session's model config and returns the outcome;
 * the model-visible envelope is appended to the session log before the
 * response so a call is never left unrecorded. Any other method is refused.
 *
 * @param ctx - Cordis context carrying the sessions and llm services.
 * @param request - the incoming request.
 * @param response - the server response.
 * @returns void.
 */
async function handleAssistRequest(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if ((error as HttpError).statusCode === 413) request.resume?.();
    writeJson(response, (error as HttpError).statusCode ?? 400, { error: (error as Error).message });
    return;
  }
  let input: AssistInput;
  try {
    input = parseAssistRequest(body);
  } catch (error) {
    writeJson(response, 400, { error: (error as Error).message });
    return;
  }
  try {
    // Resolve the live session BEFORE any model call: without a session there
    // is no model context and no place to record the model-visible envelope,
    // so the call must not proceed unrecorded (model-visible implies logged).
    const session = ctx.sessions.get(SessionId(input.sessionId));
    if (session === undefined) {
      const envelope = assistEnvelope(input);
      writeJson(response, 200, {
        status: 'no-model-context',
        sourcesText: envelope.sourcesText,
        systemText: envelope.systemText,
      });
      return;
    }
    const outcome = await runAssist({
      resolveConfig() {
        return session.requestHeader()?.config;
      },
      stream(options) {
        return ctx.llm.stream(options);
      },
    }, input);
    try {
      session.append('dsh-feedback-bridge/assist', buildAssistEventPayload(outcome, input));
    } catch {
      // A model-visible call must never proceed unlogged; failing to record
      // the envelope fails loud instead of silently dropping the audit trail.
      writeJson(response, 500, { error: 'failed to record the assist call' });
      return;
    }
    writeJson(response, 200, outcome);
  } catch {
    // Any unexpected failure must still respond so the route never hangs;
    // the user keeps their draft and manual control.
    writeJson(response, 500, { error: 'assist failed' });
  }
}

/** Plugin configuration: read-only similarity settings and the replaceable GitHub service settings. */
export interface PluginConfig {
  similarity?: unknown;
  github?: unknown;
}

/** The three intent fields the similarity route requires, in stable order. */
const SIMILARITY_FIELD_KEYS = ['scenario', 'gap', 'desired'] as const;

/**
 * Validate a similarity request body: exactly the three non-empty intent
 * fields, the feedback type, and an optional language. Anything else fails
 * loud at the wire boundary so the sources only ever receive minimal intent.
 *
 * @param body - parsed request body.
 * @returns the validated similarity input.
 * @throws {Error} describing the first invalid aspect.
 */
function parseSimilarityRequest(body: unknown): SimilarityInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be an object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['scenario', 'gap', 'desired', 'type', 'language'].includes(key)) {
      throw new Error('unsupported key: ' + key);
    }
  }
  for (const key of SIMILARITY_FIELD_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('similarity field ' + key + ' must be a non-empty string');
    }
    if (value.length > MAX_SIMILARITY_FIELD_CHARS) {
      throw new Error('similarity field ' + key + ' exceeds the ' + MAX_SIMILARITY_FIELD_CHARS + ' char cap');
    }
  }
  assertFeedbackType(record.type);
  const rawLanguage = record.language;
  if (rawLanguage !== undefined && rawLanguage !== null && rawLanguage !== 'zh' && rawLanguage !== 'en') {
    throw new Error('draft language must be zh or en');
  }
  const language: DraftLanguage | null = rawLanguage === 'zh' || rawLanguage === 'en' ? rawLanguage : null;
  return {
    scenario: record.scenario as string,
    gap: record.gap as string,
    desired: record.desired as string,
    type: record.type as FeedbackType,
    language,
  };
}

/**
 * Handle one request on the similarity route. POST runs the read-only
 * similarity check against the approved public sources and returns the
 * per-source outcome; any other method is refused. The check never writes
 * anywhere and never touches the draft or the session.
 *
 * @param config - the resolved similarity config.
 * @param request - the incoming request.
 * @param response - the server response.
 * @returns void.
 */
async function handleSimilarityRequest(config: SimilarityConfig, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if ((error as HttpError).statusCode === 413) request.resume?.();
    writeJson(response, (error as HttpError).statusCode ?? 400, { error: (error as Error).message });
    return;
  }
  let input: SimilarityInput;
  try {
    input = parseSimilarityRequest(body);
  } catch (error) {
    writeJson(response, 400, { error: (error as Error).message });
    return;
  }
  try {
    const outcome = await runSimilarity(config, input, {
      fetchImpl: (url, init) => fetch(url, init),
    });
    writeJson(response, 200, outcome);
  } catch {
    // Any unexpected failure must still respond so the route never hangs;
    // per-source failures are already reported inside the outcome.
    writeJson(response, 500, { error: 'similarity failed' });
  }
}


/**
 * Handle one GET request on the submission route: resolve the read-only
 * submission snapshot (identity, repository id, Discussion categories, and
 * the pinned official destination) and issue a one-shot prepared nonce. The
 * gh provider returns account-selection-required until the client chooses
 * one of the discovered accounts via the `account` query parameter.
 * No mutation can occur on this path.
 *
 * @param service - the replaceable GitHub service.
 * @param store - the one-shot prepared-submission store.
 * @param request - the incoming request.
 * @param response - the server response.
 * @returns void.
 */
async function handleSubmissionPrepare(service: GitHubService, store: SubmissionStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://dsh-feedback-bridge.local');
  const account = url.searchParams.get('account');
  const result = await service.prepare(account === null ? undefined : account);
  if (result.status === 'failed') {
    writeJson(response, 200, { status: 'failed', code: result.code });
    return;
  }
  if (result.status === 'account-selection-required') {
    writeJson(response, 200, { status: 'account-selection-required', accounts: result.accounts });
    return;
  }
  const preparedId = store.create({
    identity: result.identity,
    repositoryId: result.repositoryId,
    categories: result.categories,
    destination: result.destination,
  });
  writeJson(response, 200, {
    status: 'ready',
    preparedId,
    identity: result.identity,
    categories: result.categories,
    destination: result.destination,
  });
}

/**
 * Handle one POST request on the submission route: the distinct final
 * confirmation action. The prepared snapshot is consumed exactly once (a
 * second use returns 409) before the single createDiscussion mutation runs;
 * the category must come from the prepared list, and the outcome is created,
 * failed, or unknown with no automatic retry.
 *
 * @param service - the replaceable GitHub service.
 * @param store - the one-shot prepared-submission store.
 * @param request - the incoming request.
 * @param response - the server response.
 * @returns void.
 */
async function handleSubmissionConfirm(service: GitHubService, store: SubmissionStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if ((error as HttpError).statusCode === 413) request.resume?.();
    writeJson(response, (error as HttpError).statusCode ?? 400, { error: (error as Error).message });
    return;
  }
  let input: ConfirmSubmissionInput;
  try {
    input = parseConfirmSubmission(body);
  } catch (error) {
    writeJson(response, 400, { error: (error as Error).message });
    return;
  }
  const prepared = store.take(input.preparedId);
  if (prepared === null) {
    writeJson(response, 409, { error: 'prepared submission unknown or already used' });
    return;
  }
  if (!prepared.categories.some((category) => category.id === input.categoryId)) {
    writeJson(response, 200, { status: 'failed', code: 'category-unavailable' });
    return;
  }
  const outcome = await service.createDiscussion({
    title: input.title,
    body: input.body,
    categoryId: input.categoryId,
    repositoryId: prepared.repositoryId,
    identity: prepared.identity,
  });
  writeJson(response, 200, outcome);
}

/**
 * Build the same-origin submission route handler over one replaceable GitHub
 * service and one one-shot prepared-submission store: GET prepares the
 * read-only snapshot, POST performs the single authorized mutation.
 *
 * @param service - the replaceable GitHub service.
 * @param store - the one-shot prepared-submission store.
 * @returns the route handler.
 */
export function createSubmissionRouteHandler(service: GitHubService, store: SubmissionStore) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET') {
      return handleSubmissionPrepare(service, store, request, response);
    }
    return handleSubmissionConfirm(service, store, request, response);
  };
}

/**
 * Handle one request on the draft route. GET reads the persisted draft; POST
 * saves or removes it; any other method is refused. Draft content never
 * leaves this handler in logs or status payloads.
 *
 * @param request - the incoming request.
 * @param response - the server response.
 * @returns void.
 */
async function handleDraftRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const filePath = draftFilePath();
  if (request.method === 'GET') {
    try {
      const record = await load(filePath);
      writeJson(response, 200, { draft: record });
    } catch {
      writeJson(response, 500, { error: 'failed to read the draft' });
    }
    return;
  }
  if (request.method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if ((error as HttpError).statusCode === 413) request.resume?.();
      writeJson(response, (error as HttpError).statusCode ?? 400, { error: (error as Error).message });
      return;
    }
    let parsed: DraftWrite;
    try {
      parsed = parseDraftWrite(body);
    } catch (error) {
      writeJson(response, 400, { error: (error as Error).message });
      return;
    }
    try {
      if (parsed.action === 'remove') {
        await remove(filePath);
      } else {
        await save(filePath, parsed.draft, parsed.draft.sources, {
          type: parsed.type,
          ...(parsed.language !== undefined ? { language: parsed.language } : {}),
        });
      }
      writeJson(response, 200, { ok: true });
    } catch {
      writeJson(response, 500, { error: 'failed to persist the draft' });
    }
    return;
  }
  writeJson(response, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
}

/**
 * Host plugin entry point. The top-level `inject: ['webServer']` keeps this
 * plugin pending outside the Web profile; once `webServer` exists, the
 * status and draft routes below are the Host's lifecycle resources.
 *
 * @param ctx - Cordis context carrying the `webServer` service.
 * @returns void.
 */
export function apply(ctx: Context, config?: PluginConfig): void {
  assertCompatibleDsh();
  const similarityConfig = normalizeSimilarityConfig(config?.similarity);
  const githubConfig: GitHubConfig = normalizeGitHubConfig(config?.github);
  const githubService = createGitHubService(githubConfig, {
    fetchImpl: (url, init) => fetch(url, init),
    gh: createGhCli(createGhRun()),
  });
  const submissionStore = createSubmissionStore();
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler(_request, response) {
        writeJson(response, 200, statusPayload());
      },
    } satisfies WebRoute);
  }, 'dsh-feedback-bridge: status route');
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: DRAFT_PATH,
      handler: handleDraftRequest,
    } satisfies WebRoute);
  }, 'dsh-feedback-bridge: draft route');
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: ASSIST_PATH,
      handler: (request, response) => handleAssistRequest(ctx, request, response),
    } satisfies WebRoute);
  }, 'dsh-feedback-bridge: assist route');
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: SIMILARITY_PATH,
      handler: (request, response) => handleSimilarityRequest(similarityConfig, request, response),
    } satisfies WebRoute);
  }, 'dsh-feedback-bridge: similarity route');
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: SUBMISSION_PATH,
      handler: createSubmissionRouteHandler(githubService, submissionStore),
    } satisfies WebRoute);
  }, 'dsh-feedback-bridge: submission route');
}