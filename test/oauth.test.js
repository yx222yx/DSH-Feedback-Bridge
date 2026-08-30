import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAuthorizeUrl,
  createOAuthStateStore,
  createPkceChallenge,
  createPkceVerifier,
  exchangeCode,
  fetchGitHubUser,
  normalizeOAuthConfig,
  parseGrantPayload,
} from '../lib/oauth.js';

/** RFC 7636 appendix B worked example: verifier and its S256 challenge. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function baseConfig(overrides = {}) {
  return {
    clientId: 'client-123',
    authorizeEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userEndpoint: 'https://api.github.com/user',
    redirectUri: 'http://127.0.0.1:3080/dsh-feedback-bridge/oauth/callback',
    scopes: '',
    stateTtlMs: 60000,
    timeoutMs: 1000,
    ...overrides,
  };
}

/** Fake fetch recording every call and answering per endpoint. */
function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    impl(url, init) {
      calls.push({ url: String(url), body: String(init?.body ?? ''), headers: { ...(init?.headers ?? {}) } });
      const handler = routes[String(url)];
      if (handler === undefined) return Promise.reject(new Error('unexpected fetch: ' + url));
      return Promise.resolve(handler(calls.length));
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

test('createPkceChallenge produces the RFC 7636 S256 challenge for the worked example', () => {
  assert.equal(createPkceChallenge(RFC_VERIFIER), RFC_CHALLENGE);
  assert.equal(createPkceVerifier().length, 43);
  assert.notEqual(createPkceVerifier(), createPkceVerifier());
});

test('normalizeOAuthConfig applies documented defaults and fails loud on invalid values', () => {
  const merged = normalizeOAuthConfig({ clientId: 'client-123', redirectBaseUrl: 'http://127.0.0.1:9' });
  assert.equal(merged.redirectUri, 'http://127.0.0.1:9/dsh-feedback-bridge/oauth/callback');
  assert.equal(merged.clientId, 'client-123');
  assert.equal(merged.authorizeEndpoint, 'https://github.com/login/oauth/authorize');
  assert.equal(merged.tokenEndpoint, 'https://github.com/login/oauth/access_token');
  assert.equal(merged.userEndpoint, 'https://api.github.com/user');
  assert.equal(merged.stateTtlMs, 600000);
  assert.equal(merged.timeoutMs, 10000);
  assert.equal(merged.scopes, '');

  assert.throws(() => normalizeOAuthConfig({}), /clientId/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', tokenEndpoint: '' }), /tokenEndpoint/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', authorizeEndpoint: 'not-a-url' }), /authorizeEndpoint/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', stateTtlMs: 'soon' }), /stateTtlMs/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', mystery: true }), /mystery/);
});

test('the state store issues one-shot state with a verifier and rejects unknown or expired states', async () => {
  const store = createOAuthStateStore(25);
  const first = store.issue();
  const second = store.issue();
  assert.notEqual(first.state, second.state);
  assert.equal(store.consume(first.state), first.verifier);
  assert.equal(store.consume(first.state), null, 'a state must be one-shot');
  assert.equal(store.consume('nope'), null);
  const late = store.issue();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.consume(late.state), null, 'an expired state must be rejected');
});

test('buildAuthorizeUrl carries every PKCE and OAuth parameter for the chosen challenge', () => {
  const config = baseConfig({ scopes: 'repo read:org' });
  const url = new URL(buildAuthorizeUrl(config, 'state-abc', RFC_CHALLENGE));
  assert.equal(url.origin + url.pathname, config.authorizeEndpoint);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.equal(url.searchParams.get('scope'), 'repo read:org');
  assert.equal(url.searchParams.get('code_challenge'), RFC_CHALLENGE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('exchangeCode posts the code and verifier and returns the grant fields', async () => {
  const config = baseConfig();
  const fetch = fakeFetch({
    [config.tokenEndpoint]: () => jsonResponse({
      access_token: 'gho_exchange-secret',
      refresh_token: 'ghr_refresh-secret',
      expires_in: 3600,
      scope: 'repo',
    }),
  });
  const result = await exchangeCode({ fetchImpl: fetch.impl }, config, 'code-xyz', RFC_VERIFIER);
  assert.deepEqual(result, {
    status: 'ok',
    accessToken: 'gho_exchange-secret',
    refreshToken: 'ghr_refresh-secret',
    expiresInSeconds: 3600,
    scope: 'repo',
  });
  assert.equal(fetch.calls.length, 1);
  const body = new URLSearchParams(fetch.calls[0].body);
  assert.equal(body.get('client_id'), 'client-123');
  assert.equal(body.get('code'), 'code-xyz');
  assert.equal(body.get('redirect_uri'), config.redirectUri);
  assert.equal(body.get('code_verifier'), RFC_VERIFIER);
  assert.equal(fetch.calls[0].headers.accept, 'application/json');
});

test('exchangeCode maps HTTP and network failures to explicit outcomes', async () => {
  const config = baseConfig();
  const httpFail = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse({ error: 'bad_verification_code' }, 400) });
  assert.deepEqual(await exchangeCode({ fetchImpl: httpFail.impl }, config, 'code', RFC_VERIFIER), {
    status: 'failed',
    code: 'exchange-error',
  });
  const networkFail = fakeFetch({});
  assert.deepEqual(await exchangeCode({ fetchImpl: networkFail.impl }, config, 'code', RFC_VERIFIER), {
    status: 'failed',
    code: 'network',
  });
});

test('fetchGitHubUser resolves the public login with the bearer token and fails on a bad response', async () => {
  const config = baseConfig();
  const ok = fakeFetch({ [config.userEndpoint]: () => jsonResponse({ login: 'alice' }) });
  assert.deepEqual(await fetchGitHubUser({ fetchImpl: ok.impl }, config, 'gho_secret'), { login: 'alice' });
  assert.equal(ok.calls[0].headers.authorization, 'Bearer gho_secret');
  const forbidden = fakeFetch({ [config.userEndpoint]: () => jsonResponse({}, 403) });
  await assert.rejects(() => fetchGitHubUser({ fetchImpl: forbidden.impl }, config, 'gho_secret'));
  const malformed = fakeFetch({ [config.userEndpoint]: () => jsonResponse({}) });
  await assert.rejects(() => fetchGitHubUser({ fetchImpl: malformed.impl }, config, 'gho_secret'));
});

test('parseGrantPayload accepts a valid stored grant and rejects malformed ones', () => {
  const grant = {
    accessToken: 'gho_stored',
    login: 'alice',
    scopes: 'repo',
    refreshToken: 'ghr_stored',
    expiresAt: 1234567890,
  };
  assert.deepEqual(parseGrantPayload(grant), grant);
  assert.throws(() => parseGrantPayload({ login: 'alice', scopes: '' }), /accessToken/);
  assert.throws(() => parseGrantPayload({ accessToken: 'x', scopes: '' }), /login/);
  assert.throws(() => parseGrantPayload({ accessToken: 'x', login: 'a' }), /scopes/);
  assert.throws(() => parseGrantPayload('nope'), /grant/);
});

// ---------------------------------------------------------------------------
// oauth provider (submission boundary) + flow manager
// ---------------------------------------------------------------------------

import {
  createOAuthFlowManager,
  createOAuthGitHubService,
} from '../lib/oauth.js';
import { OFFICIAL_DISCUSSION_OWNER, OFFICIAL_DISCUSSION_REPO } from '../lib/github.js';

/** In-memory grant store recording every write and clear. */
function fakeGrantStore(initial) {
  let grant = initial;
  return {
    grant: () => grant,
    writes: [],
    async readGrant() { return grant; },
    async writeGrant(payload) { grant = payload; this.writes.push(payload); },
    async clearGrant() { grant = undefined; },
  };
}

/** Fake GitHub GraphQL fetch answering the read and mutation operations. */
function fakeGitHubFetch(overrides = {}) {
  const calls = [];
  return {
    calls,
    impl(url, init) {
      calls.push({ url: String(url), body: String(init?.body ?? ''), headers: { ...(init?.headers ?? {}) } });
      const match = /(query|mutation)\s+(\w+)/.exec(String(init?.body ?? ''));
      const operation = match === null ? 'unknown' : match[2];
      if (operation === 'PrepareSubmission') {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: {
              repository: {
                id: 'R_kgDOfficialRepo',
                discussionCategories: { nodes: [{ id: 'DIC_ideas', name: 'Ideas' }] },
              },
            },
          }),
        });
      }
      if (operation === 'CreateDiscussion') {
        if (overrides.mutation401) {
          return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ data: { createDiscussion: { discussion: { url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/42' } } } }),
        });
      }
      return Promise.reject(new Error('unexpected fetch: ' + String(init?.body)));
    },
  };
}

const VALID_GRANT = { accessToken: 'gho_oauth-secret', login: 'alice', scopes: 'repo' };

function oauthProviderDeps(grantStore, fetchImpl) {
  return { grantStore, fetchImpl };
}

test('oauth provider reports authorization-required with zero network calls when no grant is stored', async () => {
  const store = fakeGrantStore(undefined);
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    oauthProviderDeps(store, fetch.impl),
  );
  assert.deepEqual(await service.prepare(), { status: 'failed', code: 'authorization-required' });
  assert.equal(fetch.calls.length, 0, 'no GitHub request may leave the host without a grant');
});

test('oauth provider prepares read-only with the stored identity and its bearer token', async () => {
  const store = fakeGrantStore(VALID_GRANT);
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    oauthProviderDeps(store, fetch.impl),
  );
  const result = await service.prepare();
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.identity, { login: 'alice' });
  assert.equal(result.destination.owner, OFFICIAL_DISCUSSION_OWNER);
  assert.equal(result.destination.repo, OFFICIAL_DISCUSSION_REPO);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer gho_oauth-secret');
  assert.doesNotMatch(fetch.calls[0].body, /mutation/i);
});

test('oauth provider maps an expired grant and an expired token to authorization-expired', async () => {
  const expired = fakeGrantStore({ ...VALID_GRANT, expiresAt: Date.now() - 1000 });
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    oauthProviderDeps(expired, fetch.impl),
  );
  assert.deepEqual(await service.prepare(), { status: 'failed', code: 'authorization-expired' });
  assert.equal(fetch.calls.length, 0, 'an expired grant must never be sent');

  const fresh = fakeGrantStore(VALID_GRANT);
  const rejected = fakeGitHubFetch({ mutation401: true });
  const service2 = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    oauthProviderDeps(fresh, rejected.impl),
  );
  const prepared = await service2.prepare();
  assert.equal(prepared.status, 'ready');
  const outcome = await service2.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'authorization-expired' });
  assert.equal(rejected.calls.length, 2, 'exactly one read and one mutation attempt');
});

test('oauth provider creates exactly one Discussion mutation with the stored bearer token', async () => {
  const store = fakeGrantStore(VALID_GRANT);
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    oauthProviderDeps(store, fetch.impl),
  );
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/42' });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer gho_oauth-secret');
  assert.doesNotMatch(fetch.calls[0].body, /issues/i);
});

test('oauth provider never returns the token in any result payload', async () => {
  const store = fakeGrantStore(VALID_GRANT);
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    oauthProviderDeps(store, fetch.impl),
  );
  const prepared = await service.prepare();
  const created = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.ok(!JSON.stringify({ prepared, created }).includes('gho_oauth-secret'));
});

test('flow manager start returns a PKCE authorize URL and tracks the running attempt', async () => {
  const store = fakeGrantStore(undefined);
  const manager = createOAuthFlowManager(baseConfig(), { fetchImpl: () => Promise.reject(new Error('unused')), grantStore: store });
  const { url } = manager.start();
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(parsed.searchParams.get('code_challenge') !== null);
  assert.ok(parsed.searchParams.get('state') !== null);
  assert.deepEqual(manager.status(), { phase: 'running' });
});

test('flow manager completes a valid callback into an authorized grant stored in the credentials seam', async () => {
  const store = fakeGrantStore(undefined);
  const oauth = fakeFetch({
    [baseConfig().tokenEndpoint]: () => jsonResponse({
      access_token: 'gho_flow-secret',
      refresh_token: 'ghr_flow-secret',
      expires_in: 3600,
      scope: 'repo',
    }),
    [baseConfig().userEndpoint]: () => jsonResponse({ login: 'alice' }),
  });
  const manager = createOAuthFlowManager(baseConfig(), { fetchImpl: oauth.impl, grantStore: store });
  const { url } = manager.start();
  const state = new URL(url).searchParams.get('state');
  const accepted = await manager.handleCallback(state, 'code-flow', null);
  assert.equal(accepted, true);
  assert.deepEqual(manager.status(), { phase: 'authorized', login: 'alice' });
  assert.equal(store.grant().login, 'alice', 'the grant must be committed through the credentials seam');
  assert.equal(store.grant().accessToken, 'gho_flow-secret');
  // The client-visible status never carries the token.
  assert.ok(!JSON.stringify(manager.status()).includes('gho_flow-secret'));
});

test('flow manager refuses a mismatched or replayed callback and expires a stale state', async () => {
  const store = fakeGrantStore(undefined);
  const oauth = fakeFetch({
    [baseConfig().tokenEndpoint]: () => jsonResponse({ access_token: 'gho_x', scope: '' }),
    [baseConfig().userEndpoint]: () => jsonResponse({ login: 'alice' }),
  });
  const manager = createOAuthFlowManager(baseConfig(), { fetchImpl: oauth.impl, grantStore: store });
  manager.start();
  assert.equal(await manager.handleCallback('wrong-state', 'code', null), false, 'a mismatched state must be refused');
  assert.deepEqual(manager.status(), { phase: 'running' }, 'a spurious callback must not disturb the running attempt');

  const state = new URL(manager.start().url).searchParams.get('state');
  assert.equal(await manager.handleCallback(state, 'code-1', null), true);
  assert.equal(await manager.handleCallback(state, 'code-2', null), false, 'a replayed callback must be refused');
  assert.deepEqual(manager.status(), { phase: 'authorized', login: 'alice' });

  const expired = createOAuthFlowManager(baseConfig({ stateTtlMs: 25 }), { fetchImpl: oauth.impl, grantStore: store });
  expired.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(expired.status(), { phase: 'failed', code: 'state-expired' });
});

test('flow manager maps denial, exchange failure, and user failure to explicit outcomes', async () => {
  const store = fakeGrantStore(undefined);
  const config = baseConfig();

  const denied = createOAuthFlowManager(config, { fetchImpl: () => Promise.reject(new Error('unused')), grantStore: store });
  const deniedUrl = denied.start();
  assert.equal(await denied.handleCallback(new URL(deniedUrl.url).searchParams.get('state'), null, 'access_denied'), true);
  assert.deepEqual(denied.status(), { phase: 'failed', code: 'denied' });

  const exchangeFail = createOAuthFlowManager(config, {
    fetchImpl: (url) => (String(url) === config.tokenEndpoint
      ? Promise.resolve(jsonResponse({ error: 'bad_verification_code' }, 400))
      : Promise.reject(new Error('unexpected'))),
    grantStore: store,
  });
  const exchangeUrl = exchangeFail.start();
  assert.equal(await exchangeFail.handleCallback(new URL(exchangeUrl.url).searchParams.get('state'), 'code', null), true);
  assert.deepEqual(exchangeFail.status(), { phase: 'failed', code: 'exchange-failed' });

  const userFail = createOAuthFlowManager(config, {
    fetchImpl: (url) => (String(url) === config.tokenEndpoint
      ? Promise.resolve(jsonResponse({ access_token: 'gho_x', scope: '' }))
      : Promise.resolve(jsonResponse({}, 403))),
    grantStore: store,
  });
  const userUrl = userFail.start();
  assert.equal(await userFail.handleCallback(new URL(userUrl.url).searchParams.get('state'), 'code', null), true);
  assert.deepEqual(userFail.status(), { phase: 'failed', code: 'user-failed' });
  assert.equal(store.grant(), undefined, 'a failed flow must never commit a grant');
});

test('flow manager cancels a running attempt without writing a grant', async () => {
  const store = fakeGrantStore(undefined);
  const manager = createOAuthFlowManager(baseConfig(), { fetchImpl: () => Promise.reject(new Error('unused')), grantStore: store });
  manager.start();
  manager.cancel();
  assert.deepEqual(manager.status(), { phase: 'cancelled' });
  assert.equal(store.grant(), undefined);
});

