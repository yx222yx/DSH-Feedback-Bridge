import type { DraftLanguage, FeedbackType } from './feedback-types.js';

/**
 * Face-neutral read-only similarity check against the approved v0.1 public
 * evidence sources (Issue #1): official DeepSeek Harness Discussions (recent
 * atom feed), known official plugins (npm registry search scoped to
 * `@deepseek-ai`), and official documentation (a curated allowlist of raw
 * markdown docs). Matching is deterministic term overlap; the check never
 * labels a request as duplicate, never calls the model, never persists
 * results, and only ever issues read-only GET requests through an injected
 * fetch seam. The Client and the Host share this module's types.
 */

/** The three approved v0.1 evidence-source kinds. */
export type SimilaritySourceKind = 'discussion' | 'plugin' | 'documentation';

/** One advisory similarity hit with its public link, source type, and matched terms. */
export interface SimilarityResult {
  /** Stable render key within one outcome: `<source>:<index>`. */
  id: string;
  source: SimilaritySourceKind;
  title: string;
  url: string;
  /** The intent terms found in this hit; the concise similarity reason is locale-owned copy built from these. */
  matchedTerms: string[];
  /** Discussion entries carry their feed update time when available. */
  updatedAt?: string;
}

/** Failure kinds the UI can explain distinctly. */
export type SimilarityFailureCode = 'rate-limited' | 'timeout' | 'network' | 'parse';

/** Per-source status so the panel can explain partial failure without blocking the session. */
export type SimilaritySourceState =
  | { source: SimilaritySourceKind; status: 'ok'; resultCount: number }
  | { source: SimilaritySourceKind; status: 'empty' }
  | { source: SimilaritySourceKind; status: 'disabled' }
  | { source: SimilaritySourceKind; status: 'failed'; code: SimilarityFailureCode };

/** The successful outcome of one similarity run: combined results plus per-source states. */
export interface SimilarityOutcome {
  status: 'ok';
  results: SimilarityResult[];
  sourceStates: SimilaritySourceState[];
}

/** Minimal feedback intent sent from the Client; never carries conversation content. */
export interface SimilarityInput {
  scenario: string;
  gap: string;
  desired: string;
  type: FeedbackType;
  language: DraftLanguage | null;
}

/** Deployment-varying similarity settings; defaults documented in {@link DEFAULT_SIMILARITY_CONFIG}. */
export interface SimilarityConfig {
  timeoutMs: number;
  maxResultsPerSource: number;
  /** Byte-ish cap applied to each intent field before term extraction (privacy). */
  maxIntentFieldChars: number;
  sources: {
    discussions: { enabled: boolean; url: string };
    plugins: { enabled: boolean; url: string };
    documentation: { enabled: boolean; urls: string[] };
  };
}

/** Default similarity configuration pointing at the real public read-only endpoints. */
export const DEFAULT_SIMILARITY_CONFIG: SimilarityConfig = {
  timeoutMs: 8000,
  maxResultsPerSource: 5,
  maxIntentFieldChars: 4096,
  sources: {
    discussions: {
      enabled: true,
      url: 'https://github.com/deepseek-ai/deepseek-harness/discussions.atom',
    },
    plugins: {
      enabled: true,
      url: 'https://registry.npmjs.org/-/v1/search',
    },
    documentation: {
      enabled: true,
      urls: [
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md',
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.md',
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/development.md',
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/testing.md',
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/glossary.md',
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/defensive-patterns.md',
        'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/adding-a-tool.md',
      ],
    },
  },
};

/** The official npm scope that counts as a known plugin listing; the only third-party search excluded by design. */
const OFFICIAL_NPM_SCOPE = 'scope:@deepseek-ai';

/** Response-shaped value the fetch seam must resolve; structurally matches the global Response. */
export interface SimilarityFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** The injected read-only network seam; production wires the global fetch. */
export interface SimilarityDeps {
  fetchImpl(url: string, init: { signal?: AbortSignal }): Promise<SimilarityFetchResponse>;
}

/** Structured source failure carrying the wire-meaningful code. */
export class SimilaritySourceError extends Error {
  readonly code: SimilarityFailureCode;
  constructor(code: SimilarityFailureCode, message: string) {
    super(code + ': ' + message);
    this.code = code;
  }
}

/** Source kinds in outcome order. */
const SOURCE_ORDER: readonly SimilaritySourceKind[] = ['discussion', 'plugin', 'documentation'];

/** Small English stopword set removed before matching; the intent may be Chinese, which needs no stopwords. */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'but', 'by', 'can',
  'could', 'do', 'does', 'down', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how',
  'into', 'is', 'it', 'its', 'just', 'like', 'me', 'my', 'no', 'not', 'of', 'on', 'one', 'or',
  'our', 'out', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this',
  'to', 'two', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'want', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Extract the deterministic intent terms from a text: latin words of at least
 * three letters (stopwords removed) plus CJK character bigrams, order
 * preserved and duplicates removed. Chinese text has no word boundaries, so
 * bigrams give a stable overlap signal.
 *
 * @param text - the joined feedback intent fields.
 * @returns the normalized term list; empty when nothing extractable remains.
 */
export function extractTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    if (term === '' || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };
  // CJK runs are extracted as bigrams; strip them first so the latin pass
  // never treats Han characters as words.
  const cjkRuns: string[] = [];
  const latinText = String(text).replace(/[\u3400-\u9fff]+/gu, (run) => {
    cjkRuns.push(run);
    return ' ';
  });
  for (const match of latinText.matchAll(/[\p{L}]{3,}/gu)) {
    const word = match[0].toLowerCase();
    if (!STOPWORDS.has(word)) push(word);
  }
  for (const run of cjkRuns) {
    for (let index = 0; index < run.length - 1; index += 1) push(run.slice(index, index + 2));
  }
  return terms;
}

/**
 * Return the terms present in the title or body of one candidate, in input
 * term order. Title presence is not reordered; ordering stays deterministic.
 *
 * @param title - candidate title.
 * @param body - candidate body text.
 * @param terms - the intent terms to test.
 * @returns the matched terms.
 */
export function matchTerms(title: string, body: string, terms: readonly string[]): string[] {
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  const hits: string[] = [];
  for (const term of terms) {
    if (titleLower.includes(term) || bodyLower.includes(term)) hits.push(term);
  }
  return hits;
}

/**
 * Decode the XML entities GitHub atom feeds emit (numeric and the common named set).
 *
 * @param input - raw XML text.
 * @returns the decoded text.
 */
function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract one tag's inner text from an entry body. */
function tagText(body: string, tag: string): string {
  const match = new RegExp('<' + tag + '[^>]*>([^]*?)</' + tag + '>').exec(body);
  return match === null ? '' : decodeXmlEntities(match[1]);
}

/** Extract the first link href from an entry body. */
function linkHref(body: string): string {
  const match = /<link\b[^>]*\bhref="([^"]*)"/.exec(body);
  return match === null ? '' : decodeXmlEntities(match[1]);
}

/** Strip HTML tags from a summary and collapse whitespace. */
function stripHtml(html: string): string {
  return decodeXmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

/** One parsed atom entry. */
export interface AtomEntry {
  id: string;
  title: string;
  url: string;
  updated: string;
  summary: string;
}

/**
 * Parse a GitHub discussions atom feed into entries. Non-XML input fails
 * loud with a parse code; individual unparseable entries are skipped.
 *
 * @param xml - the atom feed text.
 * @returns the parsed entries.
 * @throws {SimilaritySourceError} code `parse` when the input is not an atom feed.
 */
export function parseAtomFeed(xml: string): AtomEntry[] {
  if (typeof xml !== 'string' || !/<entry[\s>]/.test(xml)) {
    throw new SimilaritySourceError('parse', 'atom feed is not valid XML');
  }
  const entries: AtomEntry[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null) {
    const body = match[1];
    const title = tagText(body, 'title');
    const url = linkHref(body);
    if (title === '' && url === '') continue;
    entries.push({
      id: tagText(body, 'id') || 'entry:' + entries.length,
      title,
      url,
      updated: tagText(body, 'updated') || tagText(body, 'published'),
      summary: stripHtml(tagText(body, 'content')),
    });
  }
  return entries;
}

/** One resolvable npm package hit. */
export interface NpmPackageHit {
  name: string;
  description: string;
  url: string;
}

/**
 * Parse an npm registry search payload. Entries without a resolvable link
 * are skipped (they cannot be opened); a non-object payload fails loud.
 *
 * @param json - the parsed npm search response.
 * @returns the resolvable package hits.
 * @throws {SimilaritySourceError} code `parse` when the payload is malformed.
 */
export function parseNpmSearch(json: unknown): NpmPackageHit[] {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new SimilaritySourceError('parse', 'npm search payload is not an object');
  }
  const objects = (json as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) {
    throw new SimilaritySourceError('parse', 'npm search payload has no objects array');
  }
  const hits: NpmPackageHit[] = [];
  for (const entry of objects) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const pkg = (entry as { package?: unknown }).package;
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) continue;
    const record = pkg as { name?: unknown; description?: unknown; links?: unknown };
    if (typeof record.name !== 'string' || record.name === '') continue;
    const links = record.links as { repository?: unknown; homepage?: unknown; npm?: unknown } | undefined;
    const url = typeof links?.repository === 'string' && links.repository !== ''
      ? links.repository
      : typeof links?.homepage === 'string' && links.homepage !== ''
        ? links.homepage
        : typeof links?.npm === 'string' && links.npm !== ''
          ? links.npm
          : '';
    if (url === '') continue;
    hits.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      url,
    });
  }
  return hits;
}

/** Derive the GitHub blob page URL from a raw.githubusercontent.com markdown URL; other URLs pass through. */
export function rawToBlobUrl(raw: string): string {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(raw);
  if (match === null) return raw;
  return 'https://github.com/' + match[1] + '/' + match[2] + '/blob/' + match[3] + '/' + match[4];
}

/**
 * Merge a raw user config over the defaults and validate it, failing loud at
 * load on malformed values so a misconfigured deployment never half-runs.
 *
 * @param raw - the plugin's similarity config, or undefined for defaults.
 * @returns the resolved similarity config.
 * @throws {Error} naming the first invalid config aspect.
 */
export function normalizeSimilarityConfig(raw: unknown): SimilarityConfig {
  const config = structuredClone(DEFAULT_SIMILARITY_CONFIG);
  if (raw === undefined || raw === null) return config;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-feedback-bridge: similarity config must be an object');
  }
  const record = raw as Record<string, unknown>;
  const known = new Set(['timeoutMs', 'maxResultsPerSource', 'maxIntentFieldChars', 'sources']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error('dsh-feedback-bridge: unknown similarity config key ' + key);
    }
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== 'number' || !Number.isInteger(record.timeoutMs) || record.timeoutMs < 1) {
      throw new Error('dsh-feedback-bridge: similarity.timeoutMs must be a positive integer');
    }
    config.timeoutMs = record.timeoutMs;
  }
  if (record.maxResultsPerSource !== undefined) {
    if (typeof record.maxResultsPerSource !== 'number' || !Number.isInteger(record.maxResultsPerSource)
      || record.maxResultsPerSource < 1 || record.maxResultsPerSource > 20) {
      throw new Error('dsh-feedback-bridge: similarity.maxResultsPerSource must be an integer between 1 and 20');
    }
    config.maxResultsPerSource = record.maxResultsPerSource;
  }
  if (record.maxIntentFieldChars !== undefined) {
    if (typeof record.maxIntentFieldChars !== 'number' || !Number.isInteger(record.maxIntentFieldChars)
      || record.maxIntentFieldChars < 1) {
      throw new Error('dsh-feedback-bridge: similarity.maxIntentFieldChars must be a positive integer');
    }
    config.maxIntentFieldChars = record.maxIntentFieldChars;
  }
  if (record.sources !== undefined) {
    if (record.sources === null || typeof record.sources !== 'object' || Array.isArray(record.sources)) {
      throw new Error('dsh-feedback-bridge: similarity.sources must be an object');
    }
    const sources = record.sources as Record<string, unknown>;
    for (const key of Object.keys(sources)) {
      if (!['discussions', 'plugins', 'documentation'].includes(key)) {
        throw new Error('dsh-feedback-bridge: unknown similarity.sources key ' + key);
      }
    }
    if (sources.discussions !== undefined) {
      config.sources.discussions = normalizeEndpoint(sources.discussions, 'discussions');
    }
    if (sources.plugins !== undefined) {
      config.sources.plugins = normalizeEndpoint(sources.plugins, 'plugins');
    }
    if (sources.documentation !== undefined) {
      const doc = sources.documentation;
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('dsh-feedback-bridge: similarity.sources.documentation must be an object');
      }
      const docRecord = doc as Record<string, unknown>;
      const docKnown = new Set(['enabled', 'urls']);
      for (const key of Object.keys(docRecord)) {
        if (!docKnown.has(key)) {
          throw new Error('dsh-feedback-bridge: unknown similarity.sources.documentation key ' + key);
        }
      }
      if (docRecord.enabled !== undefined) {
        if (typeof docRecord.enabled !== 'boolean') {
          throw new Error('dsh-feedback-bridge: documentation enabled must be a boolean');
        }
        config.sources.documentation.enabled = docRecord.enabled;
      }
      if (docRecord.urls !== undefined) {
        if (!Array.isArray(docRecord.urls) || docRecord.urls.some((url) => typeof url !== 'string' || url.trim() === '')) {
          throw new Error('dsh-feedback-bridge: documentation urls must be an array of non-empty strings');
        }
        config.sources.documentation.urls = [...(docRecord.urls as string[])];
      }
    }
  }
  return config;
}

/** Normalize one endpoint source (discussions or plugins) over its default. */
function normalizeEndpoint(raw: unknown, name: 'discussions' | 'plugins'): { enabled: boolean; url: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-feedback-bridge: similarity.sources.' + name + ' must be an object');
  }
  const record = raw as Record<string, unknown>;
  const known = new Set(['enabled', 'url']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error('dsh-feedback-bridge: unknown similarity.sources.' + name + ' key ' + key);
    }
  }
  const current = DEFAULT_SIMILARITY_CONFIG.sources[name];
  const merged = { enabled: current.enabled, url: current.url };
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') {
      throw new Error('dsh-feedback-bridge: similarity.sources.' + name + '.enabled must be a boolean');
    }
    merged.enabled = record.enabled;
  }
  if (record.url !== undefined) {
    if (typeof record.url !== 'string' || record.url.trim() === '') {
      throw new Error('dsh-feedback-bridge: similarity.sources.' + name + '.url must be a non-empty string');
    }
    merged.url = record.url;
  }
  return merged;
}

/**
 * Classify a fetch rejection into the wire-meaningful failure code.
 *
 * @param error - the rejected fetch error.
 * @returns the failure code.
 */
function classifyFetchError(error: unknown): SimilarityFailureCode {
  if (error instanceof SimilaritySourceError) return error.code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'network';
}

/** Extract the failure code from any thrown value. */
function failureCodeOf(reason: unknown): SimilarityFailureCode {
  return reason instanceof SimilaritySourceError ? reason.code : 'network';
}

/**
 * Fetch one source response, applying the timeout and mapping HTTP and
 * network failures to structured codes. Only read-only GET semantics are
 * used; callers never pass mutation options.
 *
 * @param url - the source URL.
 * @param timeoutMs - per-source timeout.
 * @param deps - the injected fetch seam.
 * @returns the response body text.
 * @throws {SimilaritySourceError} on failure.
 */
async function fetchSourceText(url: string, timeoutMs: number, deps: SimilarityDeps): Promise<string> {
  let response: SimilarityFetchResponse;
  try {
    response = await deps.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new SimilaritySourceError(classifyFetchError(error), 'fetch failed: ' + String(error));
  }
  if (response.status === 429 || response.status === 403) {
    throw new SimilaritySourceError('rate-limited', 'source is rate limited');
  }
  if (!response.ok) {
    throw new SimilaritySourceError('network', 'source returned HTTP ' + response.status);
  }
  return response.text();
}

/** Fetch a source and parse it as JSON; parse failures map to a parse code. */
async function fetchSourceJson(url: string, timeoutMs: number, deps: SimilarityDeps): Promise<unknown> {
  let response: SimilarityFetchResponse;
  try {
    response = await deps.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new SimilaritySourceError(classifyFetchError(error), 'fetch failed: ' + String(error));
  }
  if (response.status === 429 || response.status === 403) {
    throw new SimilaritySourceError('rate-limited', 'source is rate limited');
  }
  if (!response.ok) {
    throw new SimilaritySourceError('network', 'source returned HTTP ' + response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new SimilaritySourceError('parse', 'source returned invalid JSON: ' + String(error));
  }
}

/** A candidate with enough text to score and enough extra fields to surface. */
interface Candidate {
  title: string;
  text: string;
  url: string;
  updated?: string;
  hits: string[];
  score: number;
}

/**
 * Score candidates by term overlap (title hits count double) and return the
 * matching ones ranked deterministically: score desc, then title asc.
 *
 * @param candidates - candidates with title, text, and passthrough fields.
 * @param terms - intent terms.
 * @returns the matched candidates with hits and score.
 */
function rankByHits<T extends { title: string; text: string }>(candidates: readonly T[], terms: readonly string[]): Array<T & { hits: string[]; score: number }> {
  return candidates
    .map((candidate) => {
      const titleHits = matchTerms(candidate.title, '', terms);
      const bodyHits = matchTerms('', candidate.text, terms).filter((term) => !titleHits.includes(term));
      return {
        ...candidate,
        hits: [...titleHits, ...bodyHits],
        score: titleHits.length * 2 + bodyHits.length,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0));
}

/** Extract the first H1 heading from a markdown document, or empty. */
function firstMarkdownHeading(markdown: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match === null ? '' : match[1].trim();
}

/** Remove the first H1 line so it is not scored twice. */
function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^#\s+.*$/m, '');
}

/** Truncate each intent field to the config cap so only minimal intent text is ever sent. */
function truncateIntent(input: SimilarityInput, maxChars: number): SimilarityInput {
  return {
    scenario: input.scenario.slice(0, maxChars),
    gap: input.gap.slice(0, maxChars),
    desired: input.desired.slice(0, maxChars),
    type: input.type,
    language: input.language,
  };
}

/** One source runner result: results plus the source state to surface. */
interface SourceRun {
  results: SimilarityResult[];
  state: SimilaritySourceState;
}

/** Run the official Discussions source against the recent atom feed. */
async function runDiscussionSource(config: SimilarityConfig, terms: readonly string[], deps: SimilarityDeps): Promise<SourceRun> {
  const source: SimilaritySourceKind = 'discussion';
  if (!config.sources.discussions.enabled) return { results: [], state: { source, status: 'disabled' } };
  if (terms.length === 0) return { results: [], state: { source, status: 'empty' } };
  try {
    const xml = await fetchSourceText(config.sources.discussions.url, config.timeoutMs, deps);
    const entries = parseAtomFeed(xml);
    const ranked = rankByHits(
      entries.map((entry) => ({ title: entry.title, text: entry.summary, url: entry.url, updated: entry.updated })),
      terms,
    ).slice(0, config.maxResultsPerSource);
    const results: SimilarityResult[] = ranked.map((entry, index) => ({
      id: 'discussion:' + index,
      source,
      title: entry.title,
      url: entry.url,
      matchedTerms: entry.hits,
      ...(entry.updated !== '' ? { updatedAt: entry.updated } : {}),
    }));
    return {
      results,
      state: results.length === 0
        ? { source, status: 'empty' }
        : { source, status: 'ok', resultCount: results.length },
    };
  } catch (error) {
    return { results: [], state: { source, status: 'failed', code: failureCodeOf(error) } };
  }
}

/** Run the known-plugin source against the official-scope npm registry search. */
async function runPluginSource(config: SimilarityConfig, terms: readonly string[], deps: SimilarityDeps): Promise<SourceRun> {
  const source: SimilaritySourceKind = 'plugin';
  if (!config.sources.plugins.enabled) return { results: [], state: { source, status: 'disabled' } };
  if (terms.length === 0) return { results: [], state: { source, status: 'empty' } };
  try {
    const url = config.sources.plugins.url + '?' + new URLSearchParams({
      text: OFFICIAL_NPM_SCOPE + ' ' + terms.join(' '),
      size: String(Math.min(config.maxResultsPerSource * 3, 30)),
    }).toString();
    const json = await fetchSourceJson(url, config.timeoutMs, deps);
    const hits = parseNpmSearch(json).slice(0, config.maxResultsPerSource);
    const results: SimilarityResult[] = hits.map((hit, index) => ({
      id: 'plugin:' + index,
      source,
      title: hit.name,
      url: hit.url,
      matchedTerms: matchTerms(hit.name, hit.description, terms),
    }));
    return {
      results,
      state: results.length === 0
        ? { source, status: 'empty' }
        : { source, status: 'ok', resultCount: results.length },
    };
  } catch (error) {
    return { results: [], state: { source, status: 'failed', code: failureCodeOf(error) } };
  }
}

/** Run the official-documentation source against the curated raw markdown allowlist. */
async function runDocumentationSource(config: SimilarityConfig, terms: readonly string[], deps: SimilarityDeps): Promise<SourceRun> {
  const source: SimilaritySourceKind = 'documentation';
  if (!config.sources.documentation.enabled) return { results: [], state: { source, status: 'disabled' } };
  if (terms.length === 0) return { results: [], state: { source, status: 'empty' } };
  const settled = await Promise.allSettled(config.sources.documentation.urls.map(async (url) => ({
    url,
    text: await fetchSourceText(url, config.timeoutMs, deps),
  })));
  const fetched = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  if (fetched.length === 0) {
    const first = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    return {
      results: [],
      state: { source, status: 'failed', code: failureCodeOf(first?.reason) },
    };
  }
  const candidates = fetched.map((doc) => {
    const heading = firstMarkdownHeading(doc.text);
    return {
      title: heading !== '' ? heading : doc.url.split('/').pop() ?? doc.url,
      text: stripFirstHeading(doc.text),
      url: rawToBlobUrl(doc.url),
    };
  });
  const ranked = rankByHits(candidates, terms).slice(0, config.maxResultsPerSource);
  const results: SimilarityResult[] = ranked.map((entry, index) => ({
    id: 'documentation:' + index,
    source,
    title: entry.title,
    url: entry.url,
    matchedTerms: entry.hits,
  }));
  return {
    results,
    state: results.length === 0
      ? { source, status: 'empty' }
      : { source, status: 'ok', resultCount: results.length },
  };
}

/**
 * Run the read-only similarity check against the approved v0.1 sources.
 * Results are advisory, ephemeral, and combined from per-source states so a
 * partial failure never blocks the feedback session.
 *
 * @param config - resolved similarity config.
 * @param input - the minimal validated feedback intent.
 * @param deps - injected fetch seam.
 * @returns the outcome with results and per-source states.
 */
export async function runSimilarity(config: SimilarityConfig, input: SimilarityInput, deps: SimilarityDeps): Promise<SimilarityOutcome> {
  const truncated = truncateIntent(input, config.maxIntentFieldChars);
  const terms = extractTerms([truncated.scenario, truncated.gap, truncated.desired].join('\n'));
  const runs = await Promise.allSettled([
    runDiscussionSource(config, terms, deps),
    runPluginSource(config, terms, deps),
    runDocumentationSource(config, terms, deps),
  ]);
  const results: SimilarityResult[] = [];
  const sourceStates: SimilaritySourceState[] = [];
  runs.forEach((run, index) => {
    if (run.status === 'fulfilled') {
      results.push(...run.value.results);
      sourceStates.push(run.value.state);
    } else {
      // A runner escaping its own error handling is a plugin bug; surface it
      // as a failed source rather than failing the whole check.
      sourceStates.push({ source: SOURCE_ORDER[index], status: 'failed', code: failureCodeOf(run.reason) });
    }
  });
  return { status: 'ok', results, sourceStates };
}