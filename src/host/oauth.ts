/**
 * Host-only GitHub OAuth authorization-code + PKCE flow (Issue #10): the
 * plugin owns the complete dance — verifier/challenge, one-shot state,
 * authorize URL, callback validation, token exchange, identity resolution,
 * and grant persistence through the DSH credentials service — because the
 * DSH web profile does not compose the `ctx.authorization` seam in the
 * tested DSH version. All secrets (authorization code, PKCE verifier, access
 * and refresh tokens) stay on the Host and are never serialized into Client
 * payloads, model input, drafts, displayable events, or logs.
 *
 * This module is Host-only: it imports node:crypto and the credentials
 * service, so it must never be reachable from the Client compiler face.
 */

import { createHash, randomBytes } from 'node:crypto';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import {
  CREATE_DISCUSSION_MUTATION,
  GitHubReadError,
  mutationHttpCode,
  OFFICIAL_DISCUSSION_OWNER,
  OFFICIAL_DISCUSSION_REPO,
  OFFICIAL_DISCUSSION_URL,
  parseMutationPayload,
  postInit,
  PREPARE_QUERY,
  type DiscussionCategory,
  type GitHubConfig,
  type GitHubDeps,
  type GitHubGrantStore,
  type GitHubIdentity,
  type GitHubService,
  type GitHubSubmissionFailureCode,
  type OAuthGrantPayload,
} from './github.js';

/** Default OAuth endpoints for github.com; overridable for deployment and tests. */
export const DEFAULT_OAUTH_AUTHORIZE_ENDPOINT = 'https://github.com/login/oauth/authorize';
export const DEFAULT_OAUTH_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const DEFAULT_OAUTH_USER_ENDPOINT = 'https://api.github.com/user';
export const DEFAULT_OAUTH_STATE_TTL_MS = 600_000;

/** Deployment-varying OAuth app settings; normalized from `github.oauth`. */
export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  userEndpoint: string;
  redirectUri: string;
  scopes: string;
  stateTtlMs: number;
  timeoutMs: number;
}

/** The credential record this plugin's GitHub OAuth grant is stored under. */
export const GITHUB_OAUTH_CREDENTIAL_KEY = credentialKey('dsh-feedback-bridge', 'github-oauth');

/** Encode bytes as unpadded base64url (RFC 4648 §5). */
function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Resolve the OAuth config from the raw `github.oauth` value, failing loud
 * at load on malformed values.
 *
 * @param raw - the plugin's github.oauth config, or undefined.
 * @returns the resolved oauth config.
 * @throws {Error} naming the first invalid aspect.
 */
export function normalizeOAuthConfig(raw: unknown, fallbackBaseUrl = 'http://127.0.0.1:3080'): GitHubOAuthConfig {
  if (raw === undefined || raw === null) {
    throw new Error('dsh-feedback-bridge: github.auth provider "oauth" requires github.oauth config');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-feedback-bridge: github.oauth must be an object');
  }
  const record = raw as Record<string, unknown>;
  const known = new Set(['clientId', 'clientSecret', 'authorizeEndpoint', 'tokenEndpoint', 'userEndpoint', 'redirectBaseUrl', 'scopes', 'stateTtlMs', 'timeoutMs']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error('dsh-feedback-bridge: unknown github.oauth key ' + key);
    }
  }
  const clientId = record.clientId;
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error('dsh-feedback-bridge: github.oauth.clientId must be a non-empty string');
  }
  const urlField = (key: string, fallback: string): string => {
    const value = record[key] ?? fallback;
    if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
      throw new Error('dsh-feedback-bridge: github.oauth.' + key + ' must be an http(s) URL');
    }
    return value;
  };
  const positiveInt = (key: string, fallback: number): number => {
    const value = record[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error('dsh-feedback-bridge: github.oauth.' + key + ' must be a positive integer');
    }
    return value;
  };
  const stringField = (key: string, fallback: string): string => {
    const value = record[key] ?? fallback;
    if (typeof value !== 'string') {
      throw new Error('dsh-feedback-bridge: github.oauth.' + key + ' must be a string');
    }
    return value;
  };
  const redirectBaseUrl = record.redirectBaseUrl;
  if (redirectBaseUrl !== undefined && (typeof redirectBaseUrl !== 'string' || !/^https?:\/\//.test(redirectBaseUrl))) {
    throw new Error('dsh-feedback-bridge: github.oauth.redirectBaseUrl must be an http(s) URL');
  }
  const redirectUri = redirectBaseUrl === undefined
    ? fallbackBaseUrl.replace(/\/$/, '') + '/dsh-feedback-bridge/oauth/callback'
    : redirectBaseUrl.replace(/\/$/, '') + '/dsh-feedback-bridge/oauth/callback';
  const clientSecret = record.clientSecret;
  if (clientSecret !== undefined && typeof clientSecret !== 'string') {
    throw new Error('dsh-feedback-bridge: github.oauth.clientSecret must be a string');
  }
  return {
    clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    authorizeEndpoint: urlField('authorizeEndpoint', DEFAULT_OAUTH_AUTHORIZE_ENDPOINT),
    tokenEndpoint: urlField('tokenEndpoint', DEFAULT_OAUTH_TOKEN_ENDPOINT),
    userEndpoint: urlField('userEndpoint', DEFAULT_OAUTH_USER_ENDPOINT),
    redirectUri,
    scopes: stringField('scopes', ''),
    stateTtlMs: positiveInt('stateTtlMs', DEFAULT_OAUTH_STATE_TTL_MS),
    timeoutMs: positiveInt('timeoutMs', 10_000),
  };
}

/**
 * Validate a stored grant payload read back from the credentials service.
 *
 * @param payload - the opaque GrantRecord payload.
 * @returns the validated grant.
 * @throws {Error} when the payload is not a usable grant.
 */
export function parseGrantPayload(payload: unknown): OAuthGrantPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('dsh-feedback-bridge: stored oauth grant payload must be an object');
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['accessToken', 'login', 'scopes']) {
    const value = record[key];
    if (typeof value !== 'string') {
      throw new Error('dsh-feedback-bridge: stored oauth grant field ' + key + ' must be a string');
    }
  }
  const grant: OAuthGrantPayload = {
    accessToken: record.accessToken as string,
    login: record.login as string,
    scopes: record.scopes as string,
  };
  const refreshToken = record.refreshToken;
  if (refreshToken !== undefined && typeof refreshToken !== 'string') {
    throw new Error('dsh-feedback-bridge: stored oauth grant refreshToken must be a string');
  }
  if (refreshToken !== undefined) grant.refreshToken = refreshToken;
  const expiresAt = record.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    throw new Error('dsh-feedback-bridge: stored oauth grant expiresAt must be a number');
  }
  if (expiresAt !== undefined) grant.expiresAt = expiresAt;
  return grant;
}

/**
 * The DSH credentials adapter behind the plugin's grant store: reads, writes,
 * and clears the GitHub OAuth grant record. Writes go through the seam's
 * serialized read-modify-write path; the record payload is opaque to the seam.
 *
 * @param credentials - the injected credentials provider.
 * @returns the grant store the oauth provider and flow use.
 */
export function createCredentialsGrantStore(credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>): GitHubGrantStore {
  return {
    async readGrant() {
      const record = await credentials.readRecord(GITHUB_OAUTH_CREDENTIAL_KEY);
      if (record === undefined || record.kind !== 'grant') return undefined;
      return parseGrantPayload(record.payload);
    },
    async writeGrant(payload) {
      await credentials.modifyRecord(GITHUB_OAUTH_CREDENTIAL_KEY, async () => ({ kind: 'grant', payload }));
    },
    async clearGrant() {
      await credentials.deleteRecord(GITHUB_OAUTH_CREDENTIAL_KEY);
    },
  };
}

/** Generate a random RFC 7636 PKCE verifier (43 chars, base64url). */
export function createPkceVerifier(): string {
  return base64url(randomBytes(32));
}

/** Derive the RFC 7636 S256 code challenge from a verifier. */
export function createPkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** One issued state plus its verifier, consumable exactly once before the TTL. */
export interface OAuthStateStore {
  issue(): { state: string; verifier: string; challenge: string };
  consume(state: string): string | null;
}

/**
 * Create a one-shot state store: `issue` returns a random state bound to a
 * verifier; `consume` returns the verifier exactly once and rejects unknown
 * or expired states.
 *
 * @param ttlMs - how long an issued state stays valid.
 * @returns the store.
 */
export function createOAuthStateStore(ttlMs: number): OAuthStateStore {
  const entries = new Map<string, { verifier: string; challenge: string; expiresAt: number }>();
  return {
    issue() {
      const state = base64url(randomBytes(24));
      const verifier = createPkceVerifier();
      const challenge = createPkceChallenge(verifier);
      entries.set(state, { verifier, challenge, expiresAt: Date.now() + ttlMs });
      return { state, verifier, challenge };
    },
    consume(state) {
      const entry = entries.get(state);
      if (entry === undefined) return null;
      entries.delete(state);
      if (Date.now() > entry.expiresAt) return null;
      return entry.verifier;
    },
  };
}

/** Build the GitHub OAuth authorization URL with PKCE parameters. */
export function buildAuthorizeUrl(config: GitHubOAuthConfig, state: string, challenge: string): string {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** The token-exchange outcome: grant fields, or an explicit failure class. */
export type OAuthExchangeResult =
  | {
    status: 'ok';
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds?: number;
    scope: string;
  }
  | { status: 'failed'; code: 'exchange-error' | 'network' };

/**
 * Exchange an authorization code for tokens. The code and verifier appear
 * only in the Host-to-GitHub request body and are never returned or logged.
 *
 * @param deps - the injected fetch seam.
 * @param config - oauth config.
 * @param code - the single-use authorization code from the callback.
 * @param verifier - the PKCE verifier bound to the callback's state.
 * @returns the grant fields or an explicit failure.
 */
export async function exchangeCode(
  deps: { fetchImpl: GitHubDeps['fetchImpl'] },
  config: GitHubOAuthConfig,
  code: string,
  verifier: string,
): Promise<OAuthExchangeResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  if (config.clientSecret !== undefined) body.set('client_secret', config.clientSecret);
  let response: Awaited<ReturnType<GitHubDeps['fetchImpl']>>;
  try {
    response = await deps.fetchImpl(config.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    return { status: 'failed', code: 'network' };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: 'failed', code: response.ok ? 'exchange-error' : 'network' };
  }
  if (!response.ok) {
    return { status: 'failed', code: 'exchange-error' };
  }
  const record = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { status: 'failed', code: 'exchange-error' };
  }
  const result: OAuthExchangeResult = {
    status: 'ok',
    accessToken,
    scope: typeof record.scope === 'string' ? record.scope : '',
  };
  if (typeof record.refresh_token === 'string' && record.refresh_token !== '') {
    result.refreshToken = record.refresh_token;
  }
  if (typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)) {
    result.expiresInSeconds = record.expires_in;
  }
  return result;
}

/** Resolve the public GitHub identity for a token; throws on any failure. */
export async function fetchGitHubUser(
  deps: { fetchImpl: GitHubDeps['fetchImpl'] },
  config: GitHubOAuthConfig,
  accessToken: string,
): Promise<GitHubIdentity> {
  let response: Awaited<ReturnType<GitHubDeps['fetchImpl']>>;
  try {
    response = await deps.fetchImpl(config.userEndpoint, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + accessToken },
    });
  } catch {
    throw new Error('dsh-feedback-bridge: could not reach the GitHub user endpoint');
  }
  if (!response.ok) {
    throw new Error('dsh-feedback-bridge: GitHub user endpoint failed with HTTP ' + response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('dsh-feedback-bridge: GitHub user endpoint returned unreadable data');
  }
  const login = (payload as { login?: unknown }).login;
  if (typeof login !== 'string' || login === '') {
    throw new Error('dsh-feedback-bridge: GitHub user endpoint returned no login');
  }
  return { login };
}

/** Read HTTP classification for the oauth provider, where a 401 means the stored token is expired. */
function oauthReadHttpCode(status: number): GitHubSubmissionFailureCode {
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'authorization-expired';
  if (status === 403) return 'permission-denied';
  return 'network';
}

/** Mutation HTTP classification for the oauth provider, where a 401 means the stored token is expired. */
function oauthMutationHttpCode(status: number): GitHubSubmissionFailureCode {
  if (status === 401) return 'authorization-expired';
  return mutationHttpCode(status);
}

/** Resolve the stored grant into a usable token, or an explicit authorization failure. */
type UsableGrant =
  | { kind: 'grant'; grant: OAuthGrantPayload }
  | { kind: 'failed'; code: 'authorization-required' | 'authorization-expired' };

async function usableGrant(grantStore: GitHubGrantStore): Promise<UsableGrant> {
  const grant = await grantStore.readGrant();
  if (grant === undefined) return { kind: 'failed', code: 'authorization-required' };
  if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
    return { kind: 'failed', code: 'authorization-expired' };
  }
  return { kind: 'grant', grant };
}

/**
 * Create the oauth-backed GitHub service (Issue #10): the identity and token
 * come from the grant stored through the DSH credentials service, and every
 * request runs with that token in the Host-to-GitHub Authorization header.
 * The mutation surface is exactly the shared createDiscussion operation; the
 * token never appears in any result payload or Client response.
 *
 * @param github - resolved github config with auth provider `oauth`.
 * @param oauth - resolved oauth config.
 * @param deps - the fetch seam and the grant store.
 * @returns the service handle.
 */
export function createOAuthGitHubService(
  github: GitHubConfig,
  oauth: GitHubOAuthConfig,
  deps: { fetchImpl: GitHubDeps['fetchImpl']; grantStore: GitHubGrantStore },
): GitHubService {
  const authInit = (body: string, token: string) => {
    const init = postInit(body, github);
    init.headers.authorization = 'Bearer ' + token;
    return init;
  };
  return {
    async prepare() {
      const usable = await usableGrant(deps.grantStore);
      if (usable.kind !== 'grant') {
        return { status: 'failed', code: usable.code };
      }
      let response: Awaited<ReturnType<GitHubDeps['fetchImpl']>>;
      try {
        response = await deps.fetchImpl(github.graphqlEndpoint, authInit(JSON.stringify({
          query: PREPARE_QUERY,
          variables: { owner: OFFICIAL_DISCUSSION_OWNER, name: OFFICIAL_DISCUSSION_REPO },
        }), usable.grant.accessToken));
      } catch (error) {
        if (error instanceof GitHubReadError) {
          return { status: 'failed', code: error.code };
        }
        return { status: 'failed', code: 'network' };
      }
      if (!response.ok) {
        return { status: 'failed', code: oauthReadHttpCode(response.status) };
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
        identity: { login: usable.grant.login },
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
      const usable = await usableGrant(deps.grantStore);
      if (usable.kind !== 'grant') {
        return { status: 'failed', code: usable.code };
      }
      let response: Awaited<ReturnType<GitHubDeps['fetchImpl']>>;
      try {
        response = await deps.fetchImpl(github.graphqlEndpoint, authInit(JSON.stringify({
          query: CREATE_DISCUSSION_MUTATION,
          variables: {
            input: {
              repositoryId: input.repositoryId,
              categoryId: input.categoryId,
              title: input.title,
              body: input.body,
            },
          },
        }), usable.grant.accessToken));
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
        return { status: 'failed', code: response.ok ? 'validation-rejected' : oauthMutationHttpCode(response.status) };
      }
      return parseMutationPayload(payload, response, oauthMutationHttpCode);
    },
  };
}

/** Client-visible flow failure classes. */
export type OAuthFailureCode = 'denied' | 'state-expired' | 'exchange-failed' | 'user-failed' | 'network';

/** Client-visible status of the active OAuth attempt; never carries a secret. */
export type OAuthAttemptStatus =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'authorized'; login: string }
  | { phase: 'cancelled' }
  | { phase: 'failed'; code: OAuthFailureCode };

/** The plugin-owned OAuth flow surface used by the routes. */
export interface OAuthFlowManager {
  /** Start one attempt, replacing any previous; returns the authorize URL. */
  start(): { url: string };
  /** The current client-visible status. */
  status(): OAuthAttemptStatus;
  /** Handle the callback; returns false when the state is spurious or replayed. */
  handleCallback(state: string, code: string | null, error: string | null): Promise<boolean>;
  /** Cancel the running attempt. */
  cancel(): void;
}

/**
 * Create the plugin-owned OAuth flow manager: one attempt at a time, PKCE
 * verifier/state owned entirely on the Host, the callback validated against
 * the one-shot state, and the grant committed through the credentials seam
 * only on success.
 *
 * @param config - resolved oauth config.
 * @param deps - the fetch seam and the grant store.
 * @returns the flow manager.
 */
export function createOAuthFlowManager(
  config: GitHubOAuthConfig,
  deps: { fetchImpl: GitHubDeps['fetchImpl']; grantStore: GitHubGrantStore },
): OAuthFlowManager {
  const stateStore = createOAuthStateStore(config.stateTtlMs);
  let current: { state: string; url: string } | null = null;
  let consumed = false;
  let status: OAuthAttemptStatus = { phase: 'idle' };
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (next: OAuthAttemptStatus): void => {
    status = next;
    if (ttlTimer !== null) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
    current = null;
    consumed = false;
  };

  return {
    start() {
      if (ttlTimer !== null) clearTimeout(ttlTimer);
      const issued = stateStore.issue();
      current = { state: issued.state, url: buildAuthorizeUrl(config, issued.state, issued.challenge) };
      consumed = false;
      status = { phase: 'running' };
      ttlTimer = setTimeout(() => settle({ phase: 'failed', code: 'state-expired' }), config.stateTtlMs);
      return { url: current.url };
    },
    status() {
      return status;
    },
    async handleCallback(state, code, error) {
      if (current === null || state !== current.state || consumed) {
        return false;
      }
      consumed = true;
      const verifier = stateStore.consume(state);
      if (verifier === null) {
        settle({ phase: 'failed', code: 'state-expired' });
        return true;
      }
      if (error === 'access_denied') {
        settle({ phase: 'failed', code: 'denied' });
        return true;
      }
      if (error !== null || code === null) {
        settle({ phase: 'failed', code: 'exchange-failed' });
        return true;
      }
      const exchanged = await exchangeCode({ fetchImpl: deps.fetchImpl }, config, code, verifier);
      if (exchanged.status === 'failed') {
        settle({ phase: 'failed', code: exchanged.code === 'network' ? 'network' : 'exchange-failed' });
        return true;
      }
      let identity: GitHubIdentity;
      try {
        identity = await fetchGitHubUser({ fetchImpl: deps.fetchImpl }, config, exchanged.accessToken);
      } catch {
        settle({ phase: 'failed', code: 'user-failed' });
        return true;
      }
      const grant: OAuthGrantPayload = {
        accessToken: exchanged.accessToken,
        login: identity.login,
        scopes: exchanged.scope,
      };
      if (exchanged.refreshToken !== undefined) grant.refreshToken = exchanged.refreshToken;
      if (exchanged.expiresInSeconds !== undefined) grant.expiresAt = Date.now() + exchanged.expiresInSeconds * 1000;
      await deps.grantStore.writeGrant(grant);
      settle({ phase: 'authorized', login: identity.login });
      return true;
    },
    cancel() {
      if (current !== null) settle({ phase: 'cancelled' });
    },
  };
}

