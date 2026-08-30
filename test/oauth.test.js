import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOAuthFlowManager,
  createOAuthGitHubService,
  hasGrantedScope,
  normalizeOAuthConfig,
  parseGrantPayload,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
} from '../lib/oauth.js';
import { OFFICIAL_DISCUSSION_OWNER, OFFICIAL_DISCUSSION_REPO } from '../lib/github.js';

/** Fake fetch recording every call and answering per URL. */
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

function baseConfig(overrides = {}) {
  return {
    clientId: 'client-device',
    deviceEndpoint: 'https://github.com/login/device/code',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userEndpoint: 'https://api.github.com/user',
    scopes: 'public_repo',
    timeoutMs: 1000,
    ...overrides,
  };
}

const DEVICE_PAYLOAD = {
  device_code: 'device-secret',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

test('normalizeOAuthConfig defaults to GitHub Device Flow with public_repo and rejects the old PKCE keys', () => {
  const merged = normalizeOAuthConfig({ clientId: 'client-device' });
  assert.equal(merged.clientId, 'client-device');
  assert.equal(merged.deviceEndpoint, 'https://github.com/login/device/code');
  assert.equal(merged.tokenEndpoint, 'https://github.com/login/oauth/access_token');
  assert.equal(merged.userEndpoint, 'https://api.github.com/user');
  assert.equal(merged.scopes, 'public_repo');
  assert.equal(merged.timeoutMs, 10000);

  assert.throws(() => normalizeOAuthConfig({}), /clientId/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', clientSecret: 's' }), /clientSecret/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', authorizeEndpoint: 'http://a' }), /authorizeEndpoint/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', redirectBaseUrl: 'http://a' }), /redirectBaseUrl/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', stateTtlMs: 10 }), /stateTtlMs/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', deviceEndpoint: 'not-a-url' }), /deviceEndpoint/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', timeoutMs: 'soon' }), /timeoutMs/);
  assert.throws(() => normalizeOAuthConfig({ clientId: 'x', mystery: 1 }), /mystery/);
});

test('requestDeviceCode posts only the public client id and scope, and parses the device fields', async () => {
  const config = baseConfig();
  const fetch = fakeFetch({
    [config.deviceEndpoint]: () => jsonResponse(DEVICE_PAYLOAD),
  });
  const result = await requestDeviceCode({ fetchImpl: fetch.impl }, config);
  assert.deepEqual(result, {
    status: 'ok',
    device: {
      deviceCode: 'device-secret',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresInSeconds: 900,
      intervalSeconds: 5,
    },
  });
  assert.equal(fetch.calls.length, 1);
  const body = new URLSearchParams(fetch.calls[0].body);
  assert.equal(body.get('client_id'), 'client-device');
  assert.equal(body.get('scope'), 'public_repo');
  assert.equal(body.get('client_secret'), null, 'no client secret may ever be sent');
  assert.equal(fetch.calls[0].headers.accept, 'application/json');
});

test('requestDeviceCode maps HTTP and network failures to explicit outcomes', async () => {
  const config = baseConfig();
  const httpFail = fakeFetch({ [config.deviceEndpoint]: () => jsonResponse({ error: 'invalid_client_id' }, 400) });
  assert.deepEqual(await requestDeviceCode({ fetchImpl: httpFail.impl }, config), { status: 'failed', code: 'exchange-failed' });
  const networkFail = fakeFetch({});
  assert.deepEqual(await requestDeviceCode({ fetchImpl: networkFail.impl }, config), { status: 'failed', code: 'network' });
});

test('pollDeviceToken posts the device code with the device grant type and maps every GitHub outcome', async () => {
  const config = baseConfig();
  const cases = [
    [{ error: 'authorization_pending' }, { status: 'pending' }],
    [{ error: 'slow_down' }, { status: 'slow-down' }],
    [{ error: 'expired_token' }, { status: 'failed', code: 'expired' }],
    [{ error: 'access_denied' }, { status: 'failed', code: 'denied' }],
    [{ access_token: 'gho_poll-secret', scope: 'public_repo' }, { status: 'ok', accessToken: 'gho_poll-secret', scope: 'public_repo' }],
    [{ error: 'unsupported_grant_type' }, { status: 'failed', code: 'exchange-failed' }],
  ];
  for (const [payload, expected] of cases) {
    const fetch = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse(payload) });
    const result = await pollDeviceToken({ fetchImpl: fetch.impl }, config, 'device-secret');
    assert.deepEqual(result, expected, JSON.stringify(payload));
    const body = new URLSearchParams(fetch.calls[0].body);
    assert.equal(body.get('client_id'), 'client-device');
    assert.equal(body.get('device_code'), 'device-secret');
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(body.get('client_secret'), null);
  }
  const networkFail = fakeFetch({});
  assert.deepEqual(await pollDeviceToken({ fetchImpl: networkFail.impl }, config, 'device-secret'), { status: 'failed', code: 'network' });
  const malformed = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse({}) });
  assert.deepEqual(await pollDeviceToken({ fetchImpl: malformed.impl }, config, 'device-secret'), { status: 'failed', code: 'exchange-failed' });
});

test('pollDeviceToken parses refresh_token, expires_in, and refresh_token_expires_in when GitHub returns them', async () => {
  const config = baseConfig();
  const withRefresh = fakeFetch({
    [config.tokenEndpoint]: () => jsonResponse({
      access_token: 'gho_poll-refresh',
      scope: 'public_repo',
      refresh_token: 'ghr_poll',
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
    }),
  });
  assert.deepEqual(
    await pollDeviceToken({ fetchImpl: withRefresh.impl }, config, 'device-secret'),
    {
      status: 'ok',
      accessToken: 'gho_poll-refresh',
      scope: 'public_repo',
      refreshToken: 'ghr_poll',
      expiresInSeconds: 28800,
      refreshTokenExpiresInSeconds: 15897600,
    },
  );
  // Without the refresh fields the ok outcome carries none of them.
  const plain = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse({ access_token: 'gho_plain', scope: 'public_repo' }) });
  assert.deepEqual(
    await pollDeviceToken({ fetchImpl: plain.impl }, config, 'device-secret'),
    { status: 'ok', accessToken: 'gho_plain', scope: 'public_repo' },
  );
});

test('refreshAccessToken exchanges the refresh token with the refresh grant and parses the rotated tokens', async () => {
  const config = baseConfig();
  const fetch = fakeFetch({
    [config.tokenEndpoint]: () => jsonResponse({
      access_token: 'gho_refreshed',
      scope: 'public_repo',
      refresh_token: 'ghr_rotated',
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
    }),
  });
  assert.deepEqual(
    await refreshAccessToken({ fetchImpl: fetch.impl }, config, 'ghr_old'),
    { status: 'ok', accessToken: 'gho_refreshed', scope: 'public_repo', refreshToken: 'ghr_rotated', expiresInSeconds: 28800, refreshTokenExpiresInSeconds: 15897600 },
  );
  const body = new URLSearchParams(fetch.calls[0].body);
  assert.equal(body.get('client_id'), 'client-device');
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'ghr_old');
  assert.equal(body.get('client_secret'), null, 'device-flow tokens never require a client secret');
});

test('refreshAccessToken maps determinate GitHub rejections to authorization-expired and other failures distinctly', async () => {
  const config = baseConfig();
  for (const error of ['bad_refresh_token', 'expired_token', 'revoked', 'access_denied']) {
    const fetch = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse({ error }) });
    assert.deepEqual(await refreshAccessToken({ fetchImpl: fetch.impl }, config, 'ghr_x'), { status: 'failed', code: 'authorization-expired' }, error);
  }
  const malformed = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse({ error: 'unsupported_grant_type' }) });
  assert.deepEqual(await refreshAccessToken({ fetchImpl: malformed.impl }, config, 'ghr_x'), { status: 'failed', code: 'exchange-failed' });
  const empty = fakeFetch({ [config.tokenEndpoint]: () => jsonResponse({}) });
  assert.deepEqual(await refreshAccessToken({ fetchImpl: empty.impl }, config, 'ghr_x'), { status: 'failed', code: 'exchange-failed' });
  const network = fakeFetch({});
  assert.deepEqual(await refreshAccessToken({ fetchImpl: network.impl }, config, 'ghr_x'), { status: 'failed', code: 'network' });
});

test('hasGrantedScope requires every requested scope in the granted set', () => {
  assert.equal(hasGrantedScope('public_repo', 'public_repo'), true);
  assert.equal(hasGrantedScope('public_repo repo', 'public_repo'), true);
  assert.equal(hasGrantedScope('repo', 'public_repo'), false);
  assert.equal(hasGrantedScope('', 'public_repo'), false);
});

test('parseGrantPayload accepts a valid stored grant and rejects malformed ones', () => {
  const grant = { accessToken: 'gho_stored', login: 'alice', scopes: 'public_repo' };
  assert.deepEqual(parseGrantPayload(grant), grant);
  assert.throws(() => parseGrantPayload({ login: 'alice', scopes: '' }), /accessToken/);
  assert.throws(() => parseGrantPayload({ accessToken: 'x', scopes: '' }), /login/);
  assert.throws(() => parseGrantPayload({ accessToken: 'x', login: 'a' }), /scopes/);
  assert.throws(() => parseGrantPayload('nope'), /grant/);
});

// ---------------------------------------------------------------------------
// device flow manager
// ---------------------------------------------------------------------------

/** In-memory grant store recording writes. */
function fakeGrantStore() {
  let grant;
  return {
    grant: () => grant,
    async readGrant() { return grant; },
    async writeGrant(payload) { grant = payload; },
    async clearGrant() { grant = undefined; },
  };
}

/** Fake GitHub GraphQL fetch for the submission provider. */
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

/** Fake device + token + user endpoints; token answers per script. */
function fakeDeviceOAuth({ tokenScript, scope = 'public_repo' } = {}) {
  const config = baseConfig({
    deviceEndpoint: 'http://127.0.0.1:9/device',
    tokenEndpoint: 'http://127.0.0.1:9/token',
    userEndpoint: 'http://127.0.0.1:9/user',
  });
  let pollCount = 0;
  const fetch = fakeFetch({
    [config.deviceEndpoint]: () => jsonResponse({ ...DEVICE_PAYLOAD, interval: 0.01 }),
    [config.tokenEndpoint]: () => {
      pollCount += 1;
      const answer = tokenScript(pollCount);
      return Promise.resolve(jsonResponse(answer));
    },
    [config.userEndpoint]: () => jsonResponse({ login: 'alice' }),
  });
  return { config, fetch, pollCount: () => pollCount };
}

/** Await a manager until it leaves the running phase or the timeout passes. */
async function awaitTerminal(manager, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = manager.status();
    if (status.phase !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('manager did not settle in time: ' + JSON.stringify(manager.status()));
}

test('the flow manager starts a device flow and exposes only the user code and verification URI', async () => {
  const store = fakeGrantStore();
  const { config, fetch } = fakeDeviceOAuth({ tokenScript: () => ({ error: 'authorization_pending' }) });
  const manager = createOAuthFlowManager(config, { fetchImpl: fetch.impl, grantStore: store });
  const started = await manager.start();
  assert.deepEqual(started, { status: 'running', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
  const status = manager.status();
  assert.equal(status.phase, 'running');
  if (status.phase === 'running') {
    assert.equal(status.userCode, 'ABCD-1234');
    assert.equal(status.verificationUri, 'https://github.com/login/device');
  }
  assert.ok(!JSON.stringify(status).includes('device-secret'), 'the device code must never be exposed');
  manager.cancel();
});

test('the flow manager polls until authorization and commits the grant with the resolved identity', async () => {
  const store = fakeGrantStore();
  const { config, fetch } = fakeDeviceOAuth({ tokenScript: (n) => (n === 1 ? { error: 'authorization_pending' } : { access_token: 'gho_manager-secret', scope: 'public_repo' }) });
  const manager = createOAuthFlowManager(config, { fetchImpl: fetch.impl, grantStore: store });
  await manager.start();
  const terminal = await awaitTerminal(manager);
  assert.deepEqual(terminal, { phase: 'authorized', login: 'alice' });
  assert.equal(store.grant().login, 'alice', 'the grant must be committed through the credentials seam');
  assert.equal(store.grant().accessToken, 'gho_manager-secret');
  assert.ok(!JSON.stringify(manager.status()).includes('gho_manager-secret'), 'the token must never appear in the status');
  assert.ok(fetch.calls.some((call) => call.url.endsWith('/token')), 'the host must poll the token endpoint');
});

test('the flow manager persists the refresh token and both expiries when GitHub returns them', async () => {
  const store = fakeGrantStore();
  const { config, fetch } = fakeDeviceOAuth({ tokenScript: () => ({
    access_token: 'gho_expiring',
    scope: 'public_repo',
    refresh_token: 'ghr_flow',
    expires_in: 28800,
    refresh_token_expires_in: 15897600,
  }) });
  const manager = createOAuthFlowManager(config, { fetchImpl: fetch.impl, grantStore: store });
  await manager.start();
  const terminal = await awaitTerminal(manager);
  assert.deepEqual(terminal, { phase: 'authorized', login: 'alice' });
  const grant = store.grant();
  assert.equal(grant.refreshToken, 'ghr_flow');
  assert.ok(grant.expiresAt !== undefined && grant.expiresAt > Date.now(), 'the access-token expiry must be persisted');
  assert.ok(grant.refreshTokenExpiresAt !== undefined && grant.refreshTokenExpiresAt > Date.now(), 'the refresh-token expiry must be persisted');
  assert.ok(!JSON.stringify(manager.status()).includes('ghr_flow'), 'the refresh token must never reach the Client-visible status');
});

test('the flow manager handles slow_down by slowing down and still succeeding', async () => {
  const store = fakeGrantStore();
  // slow_down adds the RFC 8628 five-second interval, so the success poll
  // arrives about five seconds later than a plain pending poll would.
  const { config, fetch } = fakeDeviceOAuth({ tokenScript: (n) => {
    if (n === 1) return { error: 'slow_down' };
    return { access_token: 'gho_slow-secret', scope: 'public_repo' };
  } });
  const manager = createOAuthFlowManager(config, { fetchImpl: fetch.impl, grantStore: store });
  await manager.start();
  const terminal = await awaitTerminal(manager, { timeoutMs: 9000 });
  assert.deepEqual(terminal, { phase: 'authorized', login: 'alice' });
});

test('the flow manager maps expired, denied, exchange failure, and insufficient scope to distinct failures', async () => {
  const cases = [
    { script: () => ({ error: 'expired_token' }), expected: { phase: 'failed', code: 'expired' } },
    { script: () => ({ error: 'access_denied' }), expected: { phase: 'failed', code: 'denied' } },
    { script: () => ({ error: 'unsupported_grant_type' }), expected: { phase: 'failed', code: 'exchange-failed' } },
    { script: () => ({ access_token: 'gho_x', scope: 'repo' }), expected: { phase: 'failed', code: 'insufficient-scope' } },
  ];
  for (const entry of cases) {
    const store = fakeGrantStore();
    const { config, fetch } = fakeDeviceOAuth({ tokenScript: entry.script });
    const manager = createOAuthFlowManager(config, { fetchImpl: fetch.impl, grantStore: store });
    await manager.start();
    const terminal = await awaitTerminal(manager);
    assert.deepEqual(terminal, entry.expected, JSON.stringify(entry.expected));
    assert.equal(store.grant(), undefined, 'a failed flow must never commit a grant');
  }
});

test('cancelling the flow stops polling without committing a grant', async () => {
  const store = fakeGrantStore();
  const { config, fetch } = fakeDeviceOAuth({ tokenScript: () => ({ error: 'authorization_pending' }) });
  const manager = createOAuthFlowManager(config, { fetchImpl: fetch.impl, grantStore: store });
  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const callsBeforeCancel = fetch.calls.length;
  manager.cancel();
  assert.deepEqual(manager.status(), { phase: 'cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fetch.calls.length, callsBeforeCancel, 'polling must stop after cancel');
  assert.equal(store.grant(), undefined);
});

test('the device code expiry deadline fails the flow as expired without a grant', async () => {
  const store = fakeGrantStore();
  const { config, fetch } = fakeDeviceOAuth({ tokenScript: () => ({ error: 'authorization_pending' }) });
  config.scopes = 'public_repo';
  // expires_in 0.02s: the deadline passes while polling stays pending.
  const fetch2 = fakeFetch({
    [config.deviceEndpoint]: () => jsonResponse({ ...DEVICE_PAYLOAD, expires_in: 0.02, interval: 0.01 }),
    [config.tokenEndpoint]: () => Promise.resolve(jsonResponse({ error: 'authorization_pending' })),
    [config.userEndpoint]: () => Promise.resolve(jsonResponse({ login: 'alice' })),
  });
  const manager = createOAuthFlowManager(config, { fetchImpl: fetch2.impl, grantStore: store });
  await manager.start();
  const terminal = await awaitTerminal(manager);
  assert.deepEqual(terminal, { phase: 'failed', code: 'expired' });
  assert.equal(store.grant(), undefined);
});

// ---------------------------------------------------------------------------
// oauth submission provider (unchanged boundary)
// ---------------------------------------------------------------------------

const VALID_GRANT = { accessToken: 'gho_oauth-secret', login: 'alice', scopes: 'public_repo' };

test('oauth provider reports authorization-required with zero network calls when no grant is stored', async () => {
  const store = fakeGrantStore();
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    { grantStore: store, fetchImpl: fetch.impl },
  );
  assert.deepEqual(await service.prepare(), { status: 'failed', code: 'authorization-required' });
  assert.equal(fetch.calls.length, 0);
});

test('oauth provider prepares read-only with the stored identity and its bearer token', async () => {
  const store = fakeGrantStore();
  await store.writeGrant(VALID_GRANT);
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    { grantStore: store, fetchImpl: fetch.impl },
  );
  const result = await service.prepare();
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.identity, { login: 'alice' });
  assert.equal(result.destination.owner, OFFICIAL_DISCUSSION_OWNER);
  assert.equal(result.destination.repo, OFFICIAL_DISCUSSION_REPO);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer gho_oauth-secret');
});

test('oauth provider creates exactly one Discussion mutation with the stored bearer token', async () => {
  const store = fakeGrantStore();
  await store.writeGrant(VALID_GRANT);
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    { grantStore: store, fetchImpl: fetch.impl },
  );
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/42' });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer gho_oauth-secret');
  assert.ok(!JSON.stringify({ outcome }).includes('gho_oauth-secret'));
});

test('oauth provider maps an expired grant and an expired token to authorization-expired', async () => {
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, expiresAt: Date.now() - 1000 });
  const fetch = fakeGitHubFetch();
  const service = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    { grantStore: store, fetchImpl: fetch.impl },
  );
  assert.deepEqual(await service.prepare(), { status: 'failed', code: 'authorization-expired' });
  assert.equal(fetch.calls.length, 0);

  const fresh = fakeGrantStore();
  await fresh.writeGrant(VALID_GRANT);
  const rejected = fakeGitHubFetch({ mutation401: true });
  const service2 = createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig(),
    { grantStore: fresh, fetchImpl: rejected.impl },
  );
  await service2.prepare();
  const outcome = await service2.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'authorization-expired' });
});

/** Fetch seam routing token refreshes to a scripted token endpoint and everything else to the graphql fake. */
function refreshAwareFetch(tokenScript, graphql) {
  const calls = [];
  return {
    calls,
    impl(url, init) {
      calls.push({ url: String(url), body: String(init?.body ?? ''), headers: { ...(init?.headers ?? {}) } });
      if (String(url).endsWith('/token')) {
        return Promise.resolve(jsonResponse(tokenScript()));
      }
      return graphql.impl(url, init);
    },
  };
}

function oauthService(store, fetch, tokenEndpoint) {
  return createOAuthGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 1000, auth: { provider: 'oauth' } },
    baseConfig({ tokenEndpoint }),
    { grantStore: store, fetchImpl: fetch },
  );
}

test('oauth provider renews an expired grant through the refresh grant before preparing', async () => {
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, refreshToken: 'ghr_stored', expiresAt: Date.now() - 1000 });
  const tokenCalls = [];
  const graphql = fakeGitHubFetch();
  const fetch = refreshAwareFetch(() => {
    tokenCalls.push(new URLSearchParams(''));
    return { access_token: 'gho_renewed', scope: 'public_repo', refresh_token: 'ghr_rotated', expires_in: 28800 };
  }, graphql);
  const service = oauthService(store, fetch.impl, 'http://127.0.0.1:9/token');
  const result = await service.prepare();
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(tokenCalls.length, 1, 'the expired grant must be renewed once');
  const refreshBody = fetch.calls.find((call) => call.url.endsWith('/token'));
  assert.equal(new URLSearchParams(refreshBody.body).get('grant_type'), 'refresh_token');
  assert.equal(new URLSearchParams(refreshBody.body).get('refresh_token'), 'ghr_stored');
  assert.equal(store.grant().accessToken, 'gho_renewed', 'the renewed grant must be persisted');
  assert.equal(store.grant().refreshToken, 'ghr_rotated', 'the rotated refresh token must be persisted');
  assert.equal(graphql.calls[0].headers.authorization, 'Bearer gho_renewed', 'the prepare must run with the renewed token');
});

test('oauth provider clears the grant and reports authorization-expired when the refresh token is rejected', async () => {
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, refreshToken: 'ghr_dead', expiresAt: Date.now() - 1000 });
  const graphql = fakeGitHubFetch();
  const fetch = refreshAwareFetch(() => ({ error: 'bad_refresh_token' }), graphql);
  const service = oauthService(store, fetch.impl, 'http://127.0.0.1:9/token');
  assert.deepEqual(await service.prepare(), { status: 'failed', code: 'authorization-expired' });
  assert.equal(store.grant(), undefined, 'a provably dead grant must be cleared so the user re-authorizes');
  assert.equal(graphql.calls.length, 0, 'no submission request may run with a dead grant');
});

test('oauth provider renews on a server-side 401 and retries the read-only prepare once', async () => {
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, refreshToken: 'ghr_stored' });
  let tokenCalls = 0;
  let graphqlCalls = 0;
  const graphql = {
    impl(url, init) {
      graphqlCalls += 1;
      if (graphqlCalls === 1) return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { id: 'R', discussionCategories: { nodes: [{ id: 'DIC_i', name: 'Ideas' }] } } } }),
      });
    },
  };
  const fetch = refreshAwareFetch(() => {
    tokenCalls += 1;
    return { access_token: 'gho_renewed-401', scope: 'public_repo', refresh_token: 'ghr_rotated-401', expires_in: 28800 };
  }, graphql);
  const service = oauthService(store, fetch.impl, 'http://127.0.0.1:9/token');
  const result = await service.prepare();
  assert.equal(result.status, 'ready');
  assert.equal(tokenCalls, 1, 'a 401 must trigger exactly one renewal');
  assert.equal(graphqlCalls, 2, 'the rejected prepare must be retried once with the renewed token');
  assert.equal(store.grant().accessToken, 'gho_renewed-401');
  const graphqlHeaders = fetch.calls.filter((call) => call.url.endsWith('/graphql')).map((call) => call.headers.authorization);
  assert.deepEqual(graphqlHeaders, ['Bearer gho_oauth-secret', 'Bearer gho_renewed-401']);
});

test('oauth provider renews on a 401 mutation rejection and dispatches once more without duplication', async () => {
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, refreshToken: 'ghr_stored' });
  let tokenCalls = 0;
  let mutationCalls = 0;
  const graphql = {
    impl(url, init) {
      if (/mutation\s+CreateDiscussion/.test(String(init?.body ?? ''))) {
        mutationCalls += 1;
        if (mutationCalls === 1) return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { createDiscussion: { discussion: { url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/42' } } } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { repository: { id: 'R', discussionCategories: { nodes: [] } } } }) });
    },
  };
  const fetch = refreshAwareFetch(() => {
    tokenCalls += 1;
    return { access_token: 'gho_renewed-mut', scope: 'public_repo', refresh_token: 'ghr_rotated-mut', expires_in: 28800 };
  }, graphql);
  const service = oauthService(store, fetch.impl, 'http://127.0.0.1:9/token');
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/42' });
  assert.equal(tokenCalls, 1, 'a 401 must trigger exactly one renewal');
  assert.equal(mutationCalls, 2, 'one rejected attempt plus one renewed dispatch');
  assert.equal(store.grant().accessToken, 'gho_renewed-mut');
  const mutationHeaders = fetch.calls.filter((call) => call.url.endsWith('/graphql') && /mutation/.test(call.body)).map((call) => call.headers.authorization);
  assert.deepEqual(mutationHeaders, ['Bearer gho_oauth-secret', 'Bearer gho_renewed-mut']);
});

test('oauth provider never retries a mutation when the renewal itself is rejected', async () => {
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, refreshToken: 'ghr_dead' });
  let mutationCalls = 0;
  const graphql = {
    impl(url, init) {
      if (/mutation\s+CreateDiscussion/.test(String(init?.body ?? ''))) {
        mutationCalls += 1;
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { repository: { id: 'R', discussionCategories: { nodes: [] } } } }) });
    },
  };
  const fetch = refreshAwareFetch(() => ({ error: 'bad_refresh_token' }), graphql);
  const service = oauthService(store, fetch.impl, 'http://127.0.0.1:9/token');
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'authorization-expired' });
  assert.equal(mutationCalls, 1, 'a mutation may be dispatched at most once');
  assert.equal(store.grant(), undefined, 'the dead grant must be cleared');
});

test('parseGrantPayload accepts the optional refresh fields and rejects a malformed refreshTokenExpiresAt', () => {
  const grant = { accessToken: 'x', login: 'a', scopes: 's', refreshToken: 'ghr', expiresAt: 1, refreshTokenExpiresAt: 2 };
  assert.deepEqual(parseGrantPayload(grant), grant);
  assert.throws(() => parseGrantPayload({ ...grant, refreshTokenExpiresAt: 'soon' }), /refreshTokenExpiresAt/);
});

// ---------------------------------------------------------------------------
// dual provider (both device flow and gh CLI available; explicit user choice)
// ---------------------------------------------------------------------------

import { createDualGitHubService } from '../lib/oauth.js';

/** Fake gh-capable service double. */
function fakeGhService({ ready = true } = {}) {
  const calls = [];
  return {
    calls,
    async prepare(options) {
      calls.push(['prepare', options?.account ?? null]);
      if (!ready) return { status: 'failed', code: 'authorization-required' };
      return { status: 'ready', identity: { login: 'gh-user' }, repositoryId: 'R', categories: [], destination: { owner: 'deepseek-ai', repo: 'deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions' } };
    },
    async createDiscussion(input) {
      calls.push(['createDiscussion', input.identity.login]);
      return { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1' };
    },
  };
}

/** Fake oauth-capable service double. */
function fakeOauthService() {
  const calls = [];
  return {
    calls,
    async prepare() {
      calls.push(['prepare']);
      return { status: 'ready', identity: { login: 'alice' }, repositoryId: 'R', categories: [], destination: { owner: 'deepseek-ai', repo: 'deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions' } };
    },
    async createDiscussion(input) {
      calls.push(['createDiscussion', input.identity.login]);
      return { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/2' };
    },
  };
}

function fakeGhRunner(accounts) {
  return {
    async listAccounts() { return accounts; },
    async tokenFor() { throw new Error('unused'); },
  };
}

test('the dual provider requires an explicit auth choice and reports gh availability', async () => {
  const ghService = fakeGhService();
  const oauthService = fakeOauthService();
  const store = fakeGrantStore();
  const service = createDualGitHubService({ ghService, oauthService, gh: fakeGhRunner([{ login: 'gh-user', active: true }]), grantStore: store });
  assert.deepEqual(await service.prepare(), { status: 'auth-method-required', ghAvailable: true });
  assert.equal(ghService.calls.length, 0, 'no gh discovery beyond the availability probe');
  assert.equal(oauthService.calls.length, 0);

  const noGh = createDualGitHubService({ ghService, oauthService, gh: fakeGhRunner([]), grantStore: store });
  assert.deepEqual(await noGh.prepare(), { status: 'auth-method-required', ghAvailable: false });
});

test('the dual provider reuses an existing oauth grant and routes the mutation to the oauth provider', async () => {
  const ghService = fakeGhService();
  const oauthService = fakeOauthService();
  const store = fakeGrantStore();
  await store.writeGrant(VALID_GRANT);
  const service = createDualGitHubService({ ghService, oauthService, gh: fakeGhRunner([]), grantStore: store });
  const prepared = await service.prepare();
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.deepEqual(prepared.identity, { login: 'alice' });
  assert.deepEqual(oauthService.calls, [['prepare']]);
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(oauthService.calls[1], ['createDiscussion', 'alice']);
  assert.equal(ghService.calls.length, 0, 'a grant-backed session must never touch the gh provider');
});

test('the dual provider honors an explicit gh method and routes the mutation to the gh provider', async () => {
  const ghService = fakeGhService();
  const oauthService = fakeOauthService();
  const store = fakeGrantStore();
  const service = createDualGitHubService({ ghService, oauthService, gh: fakeGhRunner([]), grantStore: store });
  const prepared = await service.prepare({ method: 'gh' });
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.deepEqual(prepared.identity, { login: 'gh-user' });
  assert.deepEqual(ghService.calls, [['prepare', null]]);
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'gh-user' },
  });
  assert.deepEqual(ghService.calls[1], ['createDiscussion', 'gh-user']);
  assert.equal(oauthService.calls.length, 0, 'an explicit gh session must never touch the oauth provider');
});

test('the dual provider routes a mutation to gh when the grant login does not match the confirmed identity', async () => {
  const ghService = fakeGhService();
  const oauthService = fakeOauthService();
  const store = fakeGrantStore();
  await store.writeGrant({ ...VALID_GRANT, login: 'other' });
  const service = createDualGitHubService({ ghService, oauthService, gh: fakeGhRunner([]), grantStore: store });
  await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'gh-user' },
  });
  assert.deepEqual(ghService.calls, [['createDiscussion', 'gh-user']]);
  assert.equal(oauthService.calls.length, 0);
});
