/**
 * Face-neutral Host-side GitHub service for the final-preview and
 * authorized-submission slice (Issue #8). The service is replaceable: the
 * authorization boundary is selected by validated config (v0.1 ships the
 * `none` provider, which reports no identity; a later OAuth slice supplies a
 * real boundary), and all network access goes through an injected fetch
 * seam so a controllable fake can verify the official destination, the exact
 * mutation count, every failure class, and unknown-result safety without a
 * real GitHub account.
 *
 * The mutation surface is exactly one operation: `createDiscussion` against
 * the official `deepseek-ai/deepseek-harness` Discussions. No Issues
 * mutation or endpoint exists in this module.
 */

/** The pinned official repository; never configurable, never another repo. */
export const OFFICIAL_DISCUSSION_OWNER = 'deepseek-ai';
/** The pinned official repository; never configurable, never another repo. */
export const OFFICIAL_DISCUSSION_REPO = 'deepseek-harness';
/** The official Discussions destination shown to the user (non-localized product constant). */
export const OFFICIAL_DISCUSSION_URL =
  'https://github.com/' + OFFICIAL_DISCUSSION_OWNER + '/' + OFFICIAL_DISCUSSION_REPO + '/discussions';

/** Distinct user-facing submission failure classes (Issue #1 / #8). */
export type GitHubSubmissionFailureCode =
  | 'authorization-required'
  | 'permission-denied'
  | 'validation-rejected'
  | 'category-unavailable'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/** One Discussion category of the official repository. */
export interface DiscussionCategory {
  id: string;
  name: string;
}

/** The submission account identity supplied by the authorization boundary. */
export interface GitHubIdentity {
  login: string;
}

/** Deployment-varying GitHub service settings; defaults in {@link DEFAULT_GITHUB_CONFIG}. */
export interface GitHubConfig {
  graphqlEndpoint: string;
  timeoutMs: number;
  auth: { provider: 'none' } | { provider: 'fake'; identity: GitHubIdentity };
}

/** Default GitHub service configuration: real GraphQL endpoint, no authorization boundary. */
export const DEFAULT_GITHUB_CONFIG: GitHubConfig = {
  graphqlEndpoint: 'https://api.github.com/graphql',
  timeoutMs: 10000,
  auth: { provider: 'none' },
};

/** The official destination rendered on the final confirmation page. */
export interface OfficialDestination {
  owner: string;
  repo: string;
  url: string;
}

/** Read-only preparation outcome: identity, repository id, and categories, or a failure code. */
export type PrepareResult =
  | {
    status: 'ready';
    identity: GitHubIdentity;
    repositoryId: string;
    categories: DiscussionCategory[];
    destination: OfficialDestination;
  }
  | { status: 'failed'; code: GitHubSubmissionFailureCode };

/** The one mutation the service can perform. */
export interface CreateDiscussionInput {
  title: string;
  body: string;
  categoryId: string;
  repositoryId: string;
  identity: GitHubIdentity;
}

/** The mutation outcome: created with the permanent URL, a definite failure, or unknown. */
export type CreateDiscussionOutcome =
  | { status: 'created'; url: string }
  | { status: 'failed'; code: GitHubSubmissionFailureCode }
  | { status: 'unknown' };

/** Response-shaped value the fetch seam must resolve; structurally matches the global Response. */
export interface GitHubFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** The injected network seam; production wires the global fetch. */
export interface GitHubDeps {
  fetchImpl(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<GitHubFetchResponse>;
}

/** The replaceable GitHub service surface used by the submission routes. */
export interface GitHubService {
  /** Read-only: resolve the identity and the official repository's Discussion categories. */
  prepare(): Promise<PrepareResult>;
  /** The only mutation: create one Discussion. Never retries; exactly one request. */
  createDiscussion(input: CreateDiscussionInput): Promise<CreateDiscussionOutcome>;
}

/** Structured failure carrying the wire-meaningful code for read (prepare) requests. */
class GitHubReadError extends Error {
  readonly code: GitHubSubmissionFailureCode;
  constructor(code: GitHubSubmissionFailureCode, message: string) {
    super(code + ': ' + message);
    this.code = code;
  }
}

/** GraphQL operation resolving the official repository id and its Discussion categories. */
const PREPARE_QUERY = `query PrepareSubmission($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    discussionCategories(first: 20) {
      nodes { id name }
    }
  }
}`;

/** The single mutation operation; the only write this module can issue. */
const CREATE_DISCUSSION_MUTATION = `mutation CreateDiscussion($input: CreateDiscussionInput!) {
  createDiscussion(input: $input) {
    discussion { url }
  }
}`;

/**
 * Merge a raw user config over the defaults and validate it, failing loud at
 * load on malformed values so a misconfigured deployment never half-runs.
 *
 * @param raw - the plugin's github config, or undefined for defaults.
 * @returns the resolved github config.
 * @throws {Error} naming the first invalid config aspect.
 */
export function normalizeGitHubConfig(raw: unknown): GitHubConfig {
  const config = structuredClone(DEFAULT_GITHUB_CONFIG);
  if (raw === undefined || raw === null) return config;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-feedback-bridge: github config must be an object');
  }
  const record = raw as Record<string, unknown>;
  const known = new Set(['graphqlEndpoint', 'timeoutMs', 'auth']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error('dsh-feedback-bridge: unknown github config key ' + key);
    }
  }
  if (record.graphqlEndpoint !== undefined) {
    if (typeof record.graphqlEndpoint !== 'string' || record.graphqlEndpoint.trim() === '') {
      throw new Error('dsh-feedback-bridge: github.graphqlEndpoint must be a non-empty string');
    }
    config.graphqlEndpoint = record.graphqlEndpoint;
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== 'number' || !Number.isInteger(record.timeoutMs) || record.timeoutMs < 1) {
      throw new Error('dsh-feedback-bridge: github.timeoutMs must be a positive integer');
    }
    config.timeoutMs = record.timeoutMs;
  }
  if (record.auth !== undefined) {
    if (record.auth === null || typeof record.auth !== 'object' || Array.isArray(record.auth)) {
      throw new Error('dsh-feedback-bridge: github.auth must be an object');
    }
    const auth = record.auth as Record<string, unknown>;
    const authKnown = new Set(['provider', 'identity']);
    for (const key of Object.keys(auth)) {
      if (!authKnown.has(key)) {
        throw new Error('dsh-feedback-bridge: unknown github.auth key ' + key);
      }
    }
    if (auth.provider === 'none') {
      config.auth = { provider: 'none' };
    } else if (auth.provider === 'fake') {
      const identity = auth.identity;
      if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
        throw new Error('dsh-feedback-bridge: github.auth fake requires an identity object');
      }
      const login = (identity as Record<string, unknown>).login;
      if (typeof login !== 'string' || login.trim() === '') {
        throw new Error('dsh-feedback-bridge: github.auth.fake.identity.login must be a non-empty string');
      }
      config.auth = { provider: 'fake', identity: { login } };
    } else {
      throw new Error('dsh-feedback-bridge: github.auth.provider must be "none" or "fake"');
    }
  }
  return config;
}

/** Resolve the current identity from the configured authorization boundary. */
function identityOf(config: GitHubConfig): GitHubIdentity | null {
  return config.auth.provider === 'fake' ? config.auth.identity : null;
}

/** Build the GraphQL POST init shared by every request. */
function postInit(body: string, config: GitHubConfig): { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  };
}

/** Classify an HTTP status from a mutation response. */
function mutationHttpCode(status: number): GitHubSubmissionFailureCode {
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'authorization-required';
  if (status === 403) return 'permission-denied';
  if (status === 400 || status === 422) return 'validation-rejected';
  return 'network';
}

/** Classify the first GraphQL error type into a failure code. */
function graphqlErrorCode(errors: readonly { type?: unknown; message?: unknown }[]): GitHubSubmissionFailureCode {
  for (const error of errors) {
    const type = error.type;
    if (type === 'RATE_LIMITED') return 'rate-limited';
    if (type === 'FORBIDDEN') return 'permission-denied';
  }
  return 'validation-rejected';
}

/** Parse a mutation response body into the created URL or a definite failure. */
function parseMutationPayload(payload: unknown, response: GitHubFetchResponse): CreateDiscussionOutcome {
  if (!response.ok) {
    return { status: 'failed', code: mutationHttpCode(response.status) };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'failed', code: 'validation-rejected' };
  }
  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { status: 'failed', code: graphqlErrorCode(errors as { type?: unknown; message?: unknown }[]) };
  }
  const url = (payload as { data?: { createDiscussion?: { discussion?: { url?: unknown } } } })
    .data?.createDiscussion?.discussion?.url;
  if (typeof url !== 'string' || url === '') {
    return { status: 'failed', code: 'validation-rejected' };
  }
  return { status: 'created', url };
}

/**
 * Create the replaceable GitHub service.
 *
 * @param config - resolved github config.
 * @param deps - injected fetch seam.
 * @returns the service handle.
 */
export function createGitHubService(config: GitHubConfig, deps: GitHubDeps): GitHubService {
  return {
    async prepare() {
      const identity = identityOf(config);
      if (identity === null) {
        return { status: 'failed', code: 'authorization-required' };
      }
      let response: GitHubFetchResponse;
      try {
        response = await deps.fetchImpl(config.graphqlEndpoint, postInit(JSON.stringify({
          query: PREPARE_QUERY,
          variables: { owner: OFFICIAL_DISCUSSION_OWNER, name: OFFICIAL_DISCUSSION_REPO },
        }), config));
      } catch (error) {
        // A read can be re-run by re-preparing; only wire-meaningful codes matter.
        if (error instanceof GitHubReadError) {
          return { status: 'failed', code: error.code };
        }
        return { status: 'failed', code: 'network' };
      }
      if (!response.ok) {
        if (response.status === 429) return { status: 'failed', code: 'rate-limited' };
        if (response.status === 401) return { status: 'failed', code: 'authorization-required' };
        if (response.status === 403) return { status: 'failed', code: 'permission-denied' };
        return { status: 'failed', code: 'network' };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { status: 'failed', code: 'network' };
      }
      const repository = (payload as { data?: { repository?: { id?: unknown; discussionCategories?: { nodes?: unknown } } } })
        .data?.repository;
      const repositoryId = repository?.id;
      const nodes = repository?.discussionCategories?.nodes;
      if (typeof repositoryId !== 'string' || repositoryId === '' || !Array.isArray(nodes)) {
        return { status: 'failed', code: 'network' };
      }
      const categories: DiscussionCategory[] = [];
      for (const node of nodes) {
        if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
          const id = (node as { id?: unknown }).id;
          const name = (node as { name?: unknown }).name;
          if (typeof id === 'string' && id !== '' && typeof name === 'string' && name !== '') {
            categories.push({ id, name });
          }
        }
      }
      return {
        status: 'ready',
        identity,
        repositoryId,
        categories,
        destination: {
          owner: OFFICIAL_DISCUSSION_OWNER,
          repo: OFFICIAL_DISCUSSION_REPO,
          url: OFFICIAL_DISCUSSION_URL,
        },
      };
    },
    async createDiscussion(input) {
      let response: GitHubFetchResponse;
      try {
        response = await deps.fetchImpl(config.graphqlEndpoint, postInit(JSON.stringify({
          query: CREATE_DISCUSSION_MUTATION,
          variables: {
            input: {
              repositoryId: input.repositoryId,
              categoryId: input.categoryId,
              title: input.title,
              body: input.body,
            },
          },
        }), config));
      } catch (error) {
        // The request was dispatched: a timeout or abort means GitHub may have
        // processed it, so the result is unknown and must never be retried.
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          return { status: 'unknown' };
        }
        return { status: 'failed', code: 'network' };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // A malformed body is still a definite response, not an unknown one.
        return { status: 'failed', code: response.ok ? 'validation-rejected' : mutationHttpCode(response.status) };
      }
      return parseMutationPayload(payload, response);
    },
  };
}
