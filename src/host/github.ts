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

/** One stored GitHub CLI login on github.com, with the gh active flag. */
export interface GhAccount {
  login: string;
  active: boolean;
}

/** The runner surface the gh provider uses to discover accounts and resolve tokens. */
export interface GhCli {
  /** Read-only: resolve every stored github.com account from `gh auth status`. */
  listAccounts(): Promise<GhAccount[]>;
  /** Read-only: resolve the OAuth token of one stored account; never logged. */
  tokenFor(login: string): Promise<string>;
}

/** The stored GitHub OAuth grant the submission provider reads back from the credentials service. */
export interface OAuthGrantPayload {
  accessToken: string;
  /** The refresh token GitHub issued (when the app uses expiring tokens); enables renewal without re-login. */
  refreshToken?: string;
  /** Epoch ms at which the access token expires; absent when GitHub issued no expiry. */
  expiresAt?: number;
  /** Epoch ms at which the refresh token itself expires; absent when unknown. */
  refreshTokenExpiresAt?: number;
  login: string;
  scopes: string;
}

/** The credential seam behind the oauth provider: read, write, and clear the stored grant. */
export interface GitHubGrantStore {
  readGrant(): Promise<OAuthGrantPayload | undefined>;
  writeGrant(payload: OAuthGrantPayload): Promise<void>;
  clearGrant(): Promise<void>;
}

/** The pinned official repository; never configurable, never another repo. */
export const OFFICIAL_DISCUSSION_OWNER = 'deepseek-ai';
/** The pinned official repository; never configurable, never another repo. */
export const OFFICIAL_DISCUSSION_REPO = 'deepseek-harness';
/** The official Discussions destination shown to the user (non-localized product constant). */
export const OFFICIAL_DISCUSSION_URL =
  'https://github.com/' + OFFICIAL_DISCUSSION_OWNER + '/' + OFFICIAL_DISCUSSION_REPO + '/discussions';

/** Distinct user-facing submission failure classes (Issue #1 / #8 / #9). */
export type GitHubSubmissionFailureCode =
  | 'authorization-required'
  | 'authorization-expired'
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

/** The authorization boundary behind the replaceable service: none (draft export only), a fake acceptance identity, or the local GitHub CLI. */
export type GitHubAuthConfig =
  | { provider: 'none' }
  | { provider: 'fake'; identity: GitHubIdentity }
  | { provider: 'gh' }
  | { provider: 'oauth' }
  | { provider: 'both' };

/** Deployment-varying GitHub service settings; defaults in {@link DEFAULT_GITHUB_CONFIG}. */
export interface GitHubConfig {
  graphqlEndpoint: string;
  timeoutMs: number;
  auth: GitHubAuthConfig;
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

/** Read-only preparation outcome: identity, repository id, and categories; an account choice; or a failure code. */
export type PrepareResult =
  | {
    status: 'ready';
    identity: GitHubIdentity;
    repositoryId: string;
    categories: DiscussionCategory[];
    destination: OfficialDestination;
  }
  | { status: 'account-selection-required'; accounts: GitHubIdentity[] }
  | { status: 'auth-method-required'; ghAvailable: boolean }
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
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<GitHubFetchResponse>;
  /** The gh runner; required only when the auth provider is `gh`. */
  gh?: GhCli;
}

/** The replaceable GitHub service surface used by the submission routes. */
export interface GitHubService {
  /** Read-only: resolve the identity and the official repository's Discussion categories; the gh provider takes the explicitly selected account. */
  prepare(options?: { method?: 'gh' | 'oauth'; account?: string }): Promise<PrepareResult>;
  /** The only mutation: create one Discussion. Never retries; exactly one request. */
  createDiscussion(input: CreateDiscussionInput): Promise<CreateDiscussionOutcome>;
}

/** Structured failure carrying the wire-meaningful code for read (prepare) requests. */
export class GitHubReadError extends Error {
  readonly code: GitHubSubmissionFailureCode;
  constructor(code: GitHubSubmissionFailureCode, message: string) {
    super(code + ': ' + message);
    this.code = code;
  }
}

/** GraphQL operation resolving the official repository id and its Discussion categories. */
export const PREPARE_QUERY = `query PrepareSubmission($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    discussionCategories(first: 20) {
      nodes { id name }
    }
  }
}`;

/** The single mutation operation; the only write this module can issue. */
export const CREATE_DISCUSSION_MUTATION = `mutation CreateDiscussion($input: CreateDiscussionInput!) {
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
  const known = new Set(['graphqlEndpoint', 'timeoutMs', 'auth', 'oauth']);
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
    } else if (auth.provider === 'gh') {
      if (auth.identity !== undefined) {
        throw new Error('dsh-feedback-bridge: github.auth gh must not pin an identity; the account is selected at runtime');
      }
      config.auth = { provider: 'gh' };
    } else if (auth.provider === 'oauth') {
      if (auth.identity !== undefined) {
        throw new Error('dsh-feedback-bridge: github.auth oauth must not pin an identity; the grant is resolved at runtime');
      }
      config.auth = { provider: 'oauth' };
    } else if (auth.provider === 'both') {
      if (auth.identity !== undefined) {
        throw new Error('dsh-feedback-bridge: github.auth both must not pin an identity; the user chooses the method');
      }
      config.auth = { provider: 'both' };
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
      throw new Error('dsh-feedback-bridge: github.auth.provider must be "none", "fake", "gh", "oauth", or "both"');
    }
  }
  return config;
}

/** Resolve the current identity from the configured authorization boundary. */
function identityOf(config: GitHubConfig): GitHubIdentity | null {
  return config.auth.provider === 'fake' ? config.auth.identity : null;
}

/** Build the GraphQL POST init shared by every request. */
export function postInit(body: string, config: GitHubConfig): { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  };
}

/** Classify an HTTP status from a mutation response. */
export function mutationHttpCode(status: number): GitHubSubmissionFailureCode {
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'authorization-required';
  if (status === 403) return 'permission-denied';
  if (status === 400 || status === 422) return 'validation-rejected';
  return 'network';
}

/** Mutation HTTP classification for the gh provider, where a 401 means the stored token is expired. */
function ghMutationHttpCode(status: number): GitHubSubmissionFailureCode {
  if (status === 401) return 'authorization-expired';
  return mutationHttpCode(status);
}

/** Read HTTP classification for the gh provider; a read has no validation-rejected class. */
function ghReadHttpCode(status: number): GitHubSubmissionFailureCode {
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'authorization-expired';
  if (status === 403) return 'permission-denied';
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
export function parseMutationPayload(
  payload: unknown,
  response: GitHubFetchResponse,
  httpCode: (status: number) => GitHubSubmissionFailureCode = mutationHttpCode,
): CreateDiscussionOutcome {
  if (!response.ok) {
    return { status: 'failed', code: httpCode(response.status) };
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
  if (config.auth.provider === 'gh') {
    return createGhGitHubService(config, deps);
  }
  return {
    async prepare(_options) {
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

/**
 * Build the GraphQL POST init for the gh provider, attaching the selected
 * account's token as the Host-to-GitHub Authorization header. The token
 * leaves this module only inside this header.
 */
function ghPostInit(body: string, config: GitHubConfig, token: string): { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } {
  const init = postInit(body, config);
  init.headers.authorization = 'Bearer ' + token;
  return init;
}

/**
 * Create the gh-backed GitHub service (Issue #9): discovers stored GitHub
 * CLI accounts through the gh runner, requires an explicit selection
 * whenever more than one account exists, and runs every request with the
 * selected account's token in the Host-to-GitHub Authorization header. The
 * token never appears in any result payload, log line, or Client response;
 * the mutation surface is exactly the shared createDiscussion operation.
 *
 * @param config - resolved github config with auth provider `gh`.
 * @param deps - fetch seam plus the gh runner.
 * @returns the service handle.
 * @throws {Error} when the gh runner dependency is missing.
 */
function createGhGitHubService(config: GitHubConfig, deps: GitHubDeps): GitHubService {
  const gh = deps.gh;
  if (gh === undefined) {
    throw new Error('dsh-feedback-bridge: github.auth provider "gh" requires the gh runner dependency');
  }
  return {
    async prepare(options) {
      const account = options?.account;
      const accounts = await gh.listAccounts();
      if (accounts.length === 0) {
        return { status: 'failed', code: 'authorization-required' };
      }
      const logins: GitHubIdentity[] = accounts.map((entry) => ({ login: entry.login }));
      let selected = account;
      if (selected === undefined) {
        if (accounts.length > 1) {
          return { status: 'account-selection-required', accounts: logins };
        }
        selected = accounts[0].login;
      } else if (!accounts.some((entry) => entry.login === selected)) {
        return { status: 'account-selection-required', accounts: logins };
      }
      let token: string;
      try {
        token = await gh.tokenFor(selected);
      } catch {
        // No usable stored token: guide the user to re-authenticate; this is read-only.
        return { status: 'failed', code: 'authorization-required' };
      }
      let response: GitHubFetchResponse;
      try {
        response = await deps.fetchImpl(config.graphqlEndpoint, ghPostInit(JSON.stringify({
          query: PREPARE_QUERY,
          variables: { owner: OFFICIAL_DISCUSSION_OWNER, name: OFFICIAL_DISCUSSION_REPO },
        }), config, token));
      } catch (error) {
        // A read can be re-run by re-preparing; only wire-meaningful codes matter.
        if (error instanceof GitHubReadError) {
          return { status: 'failed', code: error.code };
        }
        return { status: 'failed', code: 'network' };
      }
      if (!response.ok) {
        return { status: 'failed', code: ghReadHttpCode(response.status) };
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
        identity: { login: selected },
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
      let token: string;
      try {
        token = await gh.tokenFor(input.identity.login);
      } catch {
        // Resolve the token before any request: without it, no mutation is attempted.
        return { status: 'failed', code: 'authorization-required' };
      }
      let response: GitHubFetchResponse;
      try {
        response = await deps.fetchImpl(config.graphqlEndpoint, ghPostInit(JSON.stringify({
          query: CREATE_DISCUSSION_MUTATION,
          variables: {
            input: {
              repositoryId: input.repositoryId,
              categoryId: input.categoryId,
              title: input.title,
              body: input.body,
            },
          },
        }), config, token));
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
        return { status: 'failed', code: response.ok ? 'validation-rejected' : ghMutationHttpCode(response.status) };
      }
      return parseMutationPayload(payload, response, ghMutationHttpCode);
    },
  };
}
