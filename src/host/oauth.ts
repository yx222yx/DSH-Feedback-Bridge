/**
 * Host-only GitHub OAuth Device Flow (Issue #10, RFC 8628): the plugin owns
 * device-code request, interval polling, token handling, identity resolution,
 * and grant persistence through the DSH credentials service. No client secret
 * is required, distributed, or configured: the published plugin ships only the
 * maintainer-registered public client ID and talks directly to GitHub's
 * official device and token endpoints — there is no callback route and no
 * project-operated OAuth backend. All secrets (device code, access token) stay
 * on the Host and are never serialized into Client payloads, model input,
 * drafts, displayable events, or logs; only the user code and verification URI
 * are shown in the active authorization UI.
 *
 * This module is Host-only: it imports the credentials service, so it must
 * never be reachable from the Client compiler face.
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import {
  CREATE_DISCUSSION_MUTATION,
  GitHubReadError,
  type GhCli,
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

/** Default endpoints for github.com; overridable for deployment and tests. */
export const DEFAULT_DEVICE_ENDPOINT = 'https://github.com/login/device/code';
export const DEFAULT_OAUTH_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const DEFAULT_OAUTH_USER_ENDPOINT = 'https://api.github.com/user';
export const DEFAULT_OAUTH_SCOPES = 'public_repo';

/** Deployment-varying Device Flow settings; normalized from `github.oauth`. */
export interface GitHubOAuthConfig {
  clientId: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  userEndpoint: string;
  scopes: string;
  timeoutMs: number;
}

/** The credential record this plugin's GitHub grant is stored under. */
export const GITHUB_OAUTH_CREDENTIAL_KEY = credentialKey('dsh-feedback-bridge', 'github-oauth');

/**
 * Resolve the Device Flow config from the raw `github.oauth` value, failing
 * loud at load on malformed values. Authorization-code/PKCE keys such as
 * `clientSecret`, `authorizeEndpoint`, `redirectBaseUrl`, and
 * `stateTtlMs` are rejected so a stale production config can never silently
 * fall back to a secret-carrying path.
 *
 * @param raw - the plugin's github.oauth config, or undefined.
 * @returns the resolved oauth config.
 * @throws {Error} naming the first invalid aspect.
 */
export function normalizeOAuthConfig(raw: unknown): GitHubOAuthConfig {
  if (raw === undefined || raw === null) {
    throw new Error('dsh-feedback-bridge: github.auth provider "oauth" requires github.oauth config');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-feedback-bridge: github.oauth must be an object');
  }
  const record = raw as Record<string, unknown>;
  const known = new Set(['clientId', 'deviceEndpoint', 'tokenEndpoint', 'userEndpoint', 'scopes', 'timeoutMs']);
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
  const scopes = record.scopes ?? DEFAULT_OAUTH_SCOPES;
  if (typeof scopes !== 'string') {
    throw new Error('dsh-feedback-bridge: github.oauth.scopes must be a string');
  }
  return {
    clientId,
    deviceEndpoint: urlField('deviceEndpoint', DEFAULT_DEVICE_ENDPOINT),
    tokenEndpoint: urlField('tokenEndpoint', DEFAULT_OAUTH_TOKEN_ENDPOINT),
    userEndpoint: urlField('userEndpoint', DEFAULT_OAUTH_USER_ENDPOINT),
    scopes,
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
 * and clears the GitHub grant record through the seam's serialized
 * read-modify-write path.
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

/** The parsed GitHub device-code response. */
export interface DeviceCodeInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** Result of requesting a device code. */
export type DeviceCodeOutcome =
  | { status: 'ok'; device: DeviceCodeInfo }
  | { status: 'failed'; code: 'exchange-failed' | 'network' };

/**
 * Request a device code from GitHub's official device endpoint. Only the
 * public client id and scope are sent; the device code itself stays on the
 * Host and is never returned to the Client or logged.
 *
 * @param deps - the injected fetch seam.
 * @param config - oauth config.
 * @returns the parsed device flow fields or an explicit failure.
 */
export async function requestDeviceCode(
  deps: { fetchImpl: GitHubDeps['fetchImpl'] },
  config: GitHubOAuthConfig,
): Promise<DeviceCodeOutcome> {
  const body = new URLSearchParams({ client_id: config.clientId, scope: config.scopes });
  let response: Awaited<ReturnType<GitHubDeps['fetchImpl']>>;
  try {
    response = await deps.fetchImpl(config.deviceEndpoint, {
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
    return { status: 'failed', code: response.ok ? 'exchange-failed' : 'network' };
  }
  if (!response.ok) {
    return { status: 'failed', code: 'exchange-failed' };
  }
  const record = payload as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  const deviceCode = record.device_code;
  const userCode = record.user_code;
  const verificationUri = record.verification_uri;
  const expiresInSeconds = record.expires_in;
  const intervalSeconds = record.interval;
  if (
    typeof deviceCode !== 'string' || deviceCode === ''
    || typeof userCode !== 'string' || userCode === ''
    || typeof verificationUri !== 'string' || verificationUri === ''
    || typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds)
    || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds)
  ) {
    return { status: 'failed', code: 'exchange-failed' };
  }
  return {
    status: 'ok',
    device: { deviceCode, userCode, verificationUri, expiresInSeconds, intervalSeconds },
  };
}

/** One poll of the device token endpoint. */
export type TokenPollOutcome =
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'ok'; accessToken: string; scope: string }
  | { status: 'failed'; code: 'denied' | 'expired' | 'exchange-failed' | 'network' };

/**
 * Poll GitHub's token endpoint with the device code, mapping every documented
 * outcome: `authorization_pending`, `slow_down`, `expired_token`,
 * `access_denied`, success, and any other failure.
 *
 * @param deps - the injected fetch seam.
 * @param config - oauth config.
 * @param deviceCode - the Host-held device code.
 * @returns the mapped outcome.
 */
export async function pollDeviceToken(
  deps: { fetchImpl: GitHubDeps['fetchImpl'] },
  config: GitHubOAuthConfig,
  deviceCode: string,
): Promise<TokenPollOutcome> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
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
    return { status: 'failed', code: response.ok ? 'exchange-failed' : 'network' };
  }
  if (!response.ok) {
    return { status: 'failed', code: 'exchange-failed' };
  }
  const record = payload as { access_token?: unknown; scope?: unknown; error?: unknown };
  if (record.access_token !== undefined) {
    const accessToken = record.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      return { status: 'failed', code: 'exchange-failed' };
    }
    return { status: 'ok', accessToken, scope: typeof record.scope === 'string' ? record.scope : '' };
  }
  switch (record.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow-down' };
    case 'expired_token':
      return { status: 'failed', code: 'expired' };
    case 'access_denied':
      return { status: 'failed', code: 'denied' };
    default:
      return { status: 'failed', code: 'exchange-failed' };
  }
}

/**
 * Whether every requested scope is present in the granted space-separated set.
 *
 * @param grantedScopes - the space-separated scopes GitHub returned.
 * @param requestedScopes - the space-separated scopes the config requested.
 * @returns true when all requested scopes are granted.
 */
export function hasGrantedScope(grantedScopes: string, requestedScopes: string): boolean {
  const granted = new Set(grantedScopes.trim().split(/\s+/).filter(Boolean));
  return requestedScopes.trim().split(/\s+/).filter(Boolean).every((scope) => granted.has(scope));
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

// ---------------------------------------------------------------------------
// submission provider (unchanged boundary, reads the stored grant)
// ---------------------------------------------------------------------------

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
    async prepare(_options) {
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

// ---------------------------------------------------------------------------
// device flow manager
// ---------------------------------------------------------------------------

/** Client-visible flow failure classes. */
export type OAuthFailureCode = 'denied' | 'expired' | 'insufficient-scope' | 'exchange-failed' | 'network';

/** Client-visible status of the active device flow; never carries a secret. */
export type OAuthAttemptStatus =
  | { phase: 'idle' }
  | { phase: 'running'; userCode: string; verificationUri: string }
  | { phase: 'authorized'; login: string }
  | { phase: 'cancelled' }
  | { phase: 'failed'; code: OAuthFailureCode };

/** Result of starting a device flow attempt. */
export type OAuthStartResult =
  | { status: 'running'; userCode: string; verificationUri: string }
  | { status: 'failed'; code: OAuthFailureCode };

/** The plugin-owned device flow surface used by the routes. */
export interface OAuthFlowManager {
  /** Start one attempt, replacing any previous; the Host polls until it settles. */
  start(): Promise<OAuthStartResult>;
  /** The current client-visible status. */
  status(): OAuthAttemptStatus;
  /** Cancel the running attempt and stop polling. */
  cancel(): void;
}

/**
 * Create the plugin-owned GitHub Device Flow manager: one attempt at a time,
 * the device code held entirely on the Host, polling driven by the Host at
 * GitHub's interval (slowed down on `slow_down`), and the grant committed
 * through the credentials seam only after the token arrives with the
 * requested scope and the public identity resolves.
 *
 * @param config - resolved oauth config.
 * @param deps - the fetch seam and the grant store.
 * @returns the flow manager.
 */
export function createOAuthFlowManager(
  config: GitHubOAuthConfig,
  deps: { fetchImpl: GitHubDeps['fetchImpl']; grantStore: GitHubGrantStore },
): OAuthFlowManager {
  let current: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
  } | null = null;
  let intervalMs = 5_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let status: OAuthAttemptStatus = { phase: 'idle' };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const settle = (next: OAuthAttemptStatus): void => {
    clearTimer();
    status = next;
    current = null;
  };

  const poll = async (): Promise<void> => {
    if (current === null) return;
    if (Date.now() > current.expiresAt) {
      settle({ phase: 'failed', code: 'expired' });
      return;
    }
    const outcome = await pollDeviceToken({ fetchImpl: deps.fetchImpl }, config, current.deviceCode);
    if (current === null) return;
    if (outcome.status === 'pending') {
      timer = setTimeout(() => void poll(), intervalMs);
      return;
    }
    if (outcome.status === 'slow-down') {
      // RFC 8628: slow_down means poll less often — add five seconds.
      intervalMs += 5_000;
      timer = setTimeout(() => void poll(), intervalMs);
      return;
    }
    if (outcome.status === 'failed') {
      settle({ phase: 'failed', code: outcome.code });
      return;
    }
    if (!hasGrantedScope(outcome.scope, config.scopes)) {
      settle({ phase: 'failed', code: 'insufficient-scope' });
      return;
    }
    let identity: GitHubIdentity;
    try {
      identity = await fetchGitHubUser({ fetchImpl: deps.fetchImpl }, config, outcome.accessToken);
    } catch {
      settle({ phase: 'failed', code: 'exchange-failed' });
      return;
    }
    if (current === null) return;
    const grant: OAuthGrantPayload = {
      accessToken: outcome.accessToken,
      login: identity.login,
      scopes: outcome.scope,
    };
    await deps.grantStore.writeGrant(grant);
    settle({ phase: 'authorized', login: identity.login });
  };

  return {
    async start() {
      clearTimer();
      const requested = await requestDeviceCode({ fetchImpl: deps.fetchImpl }, config);
      if (requested.status === 'failed') {
        settle({ phase: 'failed', code: requested.code });
        return { status: 'failed', code: requested.code };
      }
      const { device } = requested;
      current = {
        deviceCode: device.deviceCode,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresAt: Date.now() + device.expiresInSeconds * 1000,
      };
      intervalMs = Math.max(10, Math.round(device.intervalSeconds * 1000));
      status = { phase: 'running', userCode: device.userCode, verificationUri: device.verificationUri };
      timer = setTimeout(() => void poll(), intervalMs);
      return { status: 'running', userCode: device.userCode, verificationUri: device.verificationUri };
    },
    status() {
      return status;
    },
    cancel() {
      if (current !== null) settle({ phase: 'cancelled' });
    },
  };
}

/**
 * Create the dual GitHub service (Issue #10 'both'): Device Flow and the
 * GitHub CLI path are both available and the user chooses explicitly. A
 * plain prepare returns `auth-method-required` with whether a local gh
 * account exists; `prepare({method})` runs the chosen path. An existing
 * oauth grant is reused automatically. The mutation routes to the provider
 * that owns the confirmed identity: an oauth grant whose login matches the
 * confirmed identity goes through oauth, otherwise through gh.
 *
 * @param deps - the gh service, oauth service, gh runner, and grant store.
 * @returns the dual service handle.
 */
export function createDualGitHubService(deps: {
  ghService: GitHubService;
  oauthService: GitHubService;
  gh: GhCli;
  grantStore: GitHubGrantStore;
}): GitHubService {
  return {
    async prepare(options) {
      if (options?.method === 'gh') {
        return deps.ghService.prepare({ account: options.account });
      }
      if (options?.method === 'oauth') {
        return deps.oauthService.prepare();
      }
      const grant = await deps.grantStore.readGrant();
      if (grant !== undefined) {
        return deps.oauthService.prepare();
      }
      const accounts = await deps.gh.listAccounts();
      return { status: 'auth-method-required', ghAvailable: accounts.length > 0 };
    },
    async createDiscussion(input) {
      const grant = await deps.grantStore.readGrant();
      if (grant !== undefined && grant.login === input.identity.login) {
        return deps.oauthService.createDiscussion(input);
      }
      return deps.ghService.createDiscussion(input);
    },
  };
}
