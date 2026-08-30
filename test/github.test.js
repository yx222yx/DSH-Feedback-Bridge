import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGitHubService,
  DEFAULT_GITHUB_CONFIG,
  normalizeGitHubConfig,
  OFFICIAL_DISCUSSION_OWNER,
  OFFICIAL_DISCUSSION_REPO,
} from '../lib/github.js';

/** A GraphQL response-shaped value structurally matching the fetch seam. */
function graphqlResponse(payload, status = 200) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => payload,
  };
}

/** A read query response carrying the pinned official repository and two categories. */
function preparePayload(overrides = {}) {
  return {
    data: {
      repository: {
        id: 'R_kgDOfficialRepo',
        discussionCategories: {
          nodes: [
            { id: 'DIC_ideas', name: 'Ideas' },
            { id: 'DIC_qna', name: 'Q&A' },
          ],
        },
      },
    },
    ...overrides,
  };
}

/** A mutation response carrying the permanent Discussion URL. */
function createdPayload(url = 'https://github.com/deepseek-ai/deepseek-harness/discussions/1234') {
  return {
    data: {
      createDiscussion: {
        discussion: { url },
      },
    },
  };
}

function errorsPayload(type, message) {
  return { errors: [{ type, message }] };
}

/** Fake fetch dispatcher that records every call and routes by operation kind. */
function fakeFetch(routeByOperation) {
  const calls = [];
  return {
    calls,
    impl(url, init) {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      const operation = typeof parsed.query === 'string' && /mutation\s+(\w+)/.exec(parsed.query) !== null
        ? 'mutation'
        : 'query';
      const handler = routeByOperation[operation];
      if (handler === undefined) {
        return Promise.reject(new Error('unexpected fetch: ' + url + ' ' + String(init?.body).slice(0, 80)));
      }
      return Promise.resolve(handler(calls.length));
    },
  };
}

function fakeAuthConfig(identity = { login: 'fake-user' }) {
  return { auth: { provider: 'fake', identity } };
}

const BASE = { graphqlEndpoint: 'http://127.0.0.1:8123/graphql', timeoutMs: 1000 };

test('normalizeGitHubConfig applies the documented defaults for an absent config', () => {
  assert.deepEqual(normalizeGitHubConfig(undefined), DEFAULT_GITHUB_CONFIG);
  assert.equal(DEFAULT_GITHUB_CONFIG.auth.provider, 'none');
  assert.equal(DEFAULT_GITHUB_CONFIG.graphqlEndpoint, 'https://api.github.com/graphql');
});

test('normalizeGitHubConfig merges partial overrides and fails loud on invalid values', () => {
  const merged = normalizeGitHubConfig({
    graphqlEndpoint: 'http://127.0.0.1:8123/graphql',
    timeoutMs: 250,
    auth: { provider: 'fake', identity: { login: 'tester' } },
  });
  assert.equal(merged.graphqlEndpoint, 'http://127.0.0.1:8123/graphql');
  assert.equal(merged.timeoutMs, 250);
  assert.deepEqual(merged.auth, { provider: 'fake', identity: { login: 'tester' } });

  assert.throws(() => normalizeGitHubConfig({ graphqlEndpoint: '' }), /graphqlEndpoint/);
  assert.throws(() => normalizeGitHubConfig({ timeoutMs: 'abc' }), /timeoutMs/);
  assert.throws(() => normalizeGitHubConfig({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => normalizeGitHubConfig({ auth: { provider: 'mystery' } }), /auth/);
  assert.throws(() => normalizeGitHubConfig({ auth: { provider: 'fake' } }), /identity/);
  assert.throws(() => normalizeGitHubConfig({ mystery: true }), /mystery/);
});

test('prepare reports authorization-required with zero network calls when no auth boundary is configured', async () => {
  const fake = fakeFetch({});
  const service = createGitHubService({ ...BASE, auth: { provider: 'none' } }, { fetchImpl: fake.impl });
  const result = await service.prepare();
  assert.deepEqual(result, { status: 'failed', code: 'authorization-required' });
  assert.equal(fake.calls.length, 0);
});

test('prepare resolves the pinned official repository and its categories read-only', async () => {
  const fake = fakeFetch({
    query: () => graphqlResponse(preparePayload()),
  });
  const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, { fetchImpl: fake.impl });
  const result = await service.prepare();

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.identity.login, 'fake-user');
  assert.equal(result.repositoryId, 'R_kgDOfficialRepo');
  assert.deepEqual(result.categories, [
    { id: 'DIC_ideas', name: 'Ideas' },
    { id: 'DIC_qna', name: 'Q&A' },
  ]);
  assert.equal(result.destination.owner, OFFICIAL_DISCUSSION_OWNER);
  assert.equal(result.destination.repo, OFFICIAL_DISCUSSION_REPO);
  assert.equal(result.destination.url, 'https://github.com/deepseek-ai/deepseek-harness/discussions');

  // The only request is a read query pinned to the official repository.
  assert.equal(fake.calls.length, 1);
  const body = JSON.parse(fake.calls[0].body);
  assert.match(body.query, /PrepareSubmission/);
  assert.doesNotMatch(body.query, /mutation/i);
  assert.deepEqual(body.variables, { owner: 'deepseek-ai', name: 'deepseek-harness' });
  assert.doesNotMatch(body.query, /issues/i);
});

test('prepare maps read failures to distinct codes', async () => {
  const rateLimited = createGitHubService({ ...BASE, ...fakeAuthConfig() }, {
    fetchImpl: () => Promise.resolve(graphqlResponse({}, 429)),
  });
  assert.deepEqual(await rateLimited.prepare(), { status: 'failed', code: 'rate-limited' });

  const forbidden = createGitHubService({ ...BASE, ...fakeAuthConfig() }, {
    fetchImpl: () => Promise.resolve(graphqlResponse({}, 403)),
  });
  assert.deepEqual(await forbidden.prepare(), { status: 'failed', code: 'permission-denied' });

  const unreachable = createGitHubService({ ...BASE, ...fakeAuthConfig() }, {
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  assert.deepEqual(await unreachable.prepare(), { status: 'failed', code: 'network' });
});

test('createDiscussion sends exactly one mutation and returns the permanent Discussion URL', async () => {
  const fake = fakeFetch({
    mutation: () => graphqlResponse(createdPayload()),
  });
  const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, { fetchImpl: fake.impl });
  const outcome = await service.createDiscussion({
    title: 'Export a plugin draft',
    body: '# Export a plugin draft\n\nBody text.',
    categoryId: 'DIC_ideas',
    repositoryId: 'R_kgDOfficialRepo',
    identity: { login: 'fake-user' },
  });

  assert.deepEqual(outcome, { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1234' });
  assert.equal(fake.calls.length, 1, 'exactly one mutation request must be sent');
  const body = JSON.parse(fake.calls[0].body);
  assert.match(body.query, /mutation\s+CreateDiscussion/);
  assert.doesNotMatch(body.query, /issues/i);
  assert.deepEqual(body.variables, {
    input: {
      repositoryId: 'R_kgDOfficialRepo',
      categoryId: 'DIC_ideas',
      title: 'Export a plugin draft',
      body: '# Export a plugin draft\n\nBody text.',
    },
  });
});

test('createDiscussion maps GraphQL error types to distinct failure codes', async () => {
  const cases = [
    [{ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 'rate-limited'],
    [{ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }, 'permission-denied'],
    [{ errors: [{ type: 'VALIDATION', message: 'Title is invalid' }] }, 'validation-rejected'],
  ];
  for (const [payload, expected] of cases) {
    const fake = fakeFetch({ mutation: () => graphqlResponse(payload) });
    const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, { fetchImpl: fake.impl });
    const outcome = await service.createDiscussion({
      title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'fake-user' },
    });
    assert.deepEqual(outcome, { status: 'failed', code: expected });
    assert.equal(fake.calls.length, 1);
  }
});

test('createDiscussion maps HTTP status failures to distinct codes', async () => {
  const cases = [
    [429, 'rate-limited'],
    [401, 'authorization-required'],
    [403, 'permission-denied'],
    [500, 'network'],
  ];
  for (const [status, expected] of cases) {
    const fake = fakeFetch({ mutation: () => graphqlResponse({}, status) });
    const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, { fetchImpl: fake.impl });
    const outcome = await service.createDiscussion({
      title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'fake-user' },
    });
    assert.deepEqual(outcome, { status: 'failed', code: expected });
    assert.equal(fake.calls.length, 1);
  }
});

test('createDiscussion maps a connection failure to network without retrying', async () => {
  const calls = [];
  const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, {
    fetchImpl(url, init) {
      calls.push({ url, body: String(init?.body ?? '') });
      return Promise.reject(new Error('ECONNREFUSED'));
    },
  });
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'fake-user' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'network' });
  assert.equal(calls.length, 1, 'a failed mutation must never retry');
});

test('createDiscussion reports unknown after the request was dispatched and never retries', async () => {
  const calls = [];
  const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, {
    fetchImpl(url, init) {
      calls.push({ url, body: String(init?.body ?? '') });
      const error = new Error('timeout after dispatch');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    },
  });
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'fake-user' },
  });
  assert.deepEqual(outcome, { status: 'unknown' });
  assert.equal(calls.length, 1, 'an unknown mutation result must never be retried');
});

test('createDiscussion treats a 200 without a resolvable URL as a rejected response', async () => {
  const fake = fakeFetch({ mutation: () => graphqlResponse({ data: { createDiscussion: { discussion: {} } } }) });
  const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, { fetchImpl: fake.impl });
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'fake-user' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'validation-rejected' });
  assert.equal(fake.calls.length, 1);
});

test('createDiscussion never issues any Issues mutation or endpoint', async () => {
  const fake = fakeFetch({ mutation: () => graphqlResponse(createdPayload()) });
  const service = createGitHubService({ ...BASE, ...fakeAuthConfig() }, { fetchImpl: fake.impl });
  await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'fake-user' },
  });
  const body = fake.calls[0].body;
  assert.doesNotMatch(body, /issues/i);
  assert.doesNotMatch(fake.calls[0].url, /issues/i);
  assert.ok(fake.calls[0].url.endsWith('/graphql'));
});
/** Fake gh runner recording every call and resolving canned accounts/tokens. */
function fakeGh(accounts, tokens = {}) {
  const calls = [];
  return {
    calls,
    async listAccounts() {
      calls.push(['listAccounts']);
      return accounts;
    },
    async tokenFor(login) {
      calls.push(['tokenFor', login]);
      const token = tokens[login];
      if (token === undefined) throw new Error('no token for ' + login);
      return token;
    },
  };
}

/** Fake fetch dispatcher that also records every request header. */
function fakeFetchWithHeaders(routeByOperation) {
  const calls = [];
  return {
    calls,
    impl(url, init) {
      calls.push({ url: String(url), body: String(init?.body ?? ''), headers: { ...(init?.headers ?? {}) } });
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      const operation = typeof parsed.query === 'string' && /mutation\s+(\w+)/.exec(parsed.query) !== null
        ? 'mutation'
        : 'query';
      const handler = routeByOperation[operation];
      if (handler === undefined) {
        return Promise.reject(new Error('unexpected fetch: ' + url + ' ' + String(init?.body).slice(0, 80)));
      }
      return Promise.resolve(handler(calls.length));
    },
  };
}

function ghAuthConfig() {
  return { auth: { provider: 'gh' } };
}

const FAKE_TOKEN = 'gho_contract-secret-alice';

test('normalizeGitHubConfig accepts the gh provider and rejects a pinned identity or unknown providers', () => {
  assert.deepEqual(normalizeGitHubConfig({ auth: { provider: 'gh' } }).auth, { provider: 'gh' });
  assert.throws(() => normalizeGitHubConfig({ auth: { provider: 'gh', identity: { login: 'alice' } } }), /identity/);
  assert.throws(() => normalizeGitHubConfig({ auth: { provider: 'mystery' } }), /provider/);
});

test('gh prepare reports authorization-required with zero network calls when no account is stored', async () => {
  const gh = fakeGh([]);
  const fake = fakeFetchWithHeaders({});
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const result = await service.prepare();
  assert.deepEqual(result, { status: 'failed', code: 'authorization-required' });
  assert.deepEqual(gh.calls, [['listAccounts']]);
  assert.equal(fake.calls.length, 0, 'no GitHub request may leave the host without an account');
});

test('gh prepare auto-selects the single stored account and sends the read query with its token', async () => {
  const gh = fakeGh([{ login: 'alice', active: true }], { alice: FAKE_TOKEN });
  const fake = fakeFetchWithHeaders({ query: () => graphqlResponse(preparePayload()) });
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const result = await service.prepare();
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.identity.login, 'alice');
  assert.deepEqual(gh.calls, [['listAccounts'], ['tokenFor', 'alice']]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].headers.authorization, 'Bearer ' + FAKE_TOKEN, 'the token travels Host-to-GitHub only');
});

test('gh prepare with several accounts forces explicit selection and never fetches', async () => {
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ]);
  const fake = fakeFetchWithHeaders({});
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const result = await service.prepare();
  assert.deepEqual(result, {
    status: 'account-selection-required',
    accounts: [{ login: 'alice' }, { login: 'bob' }],
  });
  assert.equal(fake.calls.length, 0, 'no categories may resolve before the account is chosen');
});

test('gh prepare honors an explicitly selected account and rejects an unknown one', async () => {
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ], { bob: 'gho_contract-secret-bob' });
  const fake = fakeFetchWithHeaders({ query: () => graphqlResponse(preparePayload()) });
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });

  const ready = await service.prepare('bob');
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  assert.equal(ready.identity.login, 'bob');
  assert.equal(fake.calls[0].headers.authorization, 'Bearer gho_contract-secret-bob');

  const unknown = await service.prepare('mallory');
  assert.deepEqual(unknown, {
    status: 'account-selection-required',
    accounts: [{ login: 'alice' }, { login: 'bob' }],
  });
});

test('gh prepare maps read failures to distinct codes including authorization-expired', async () => {
  const cases = [
    [{}, 401, 'authorization-expired'],
    [{}, 403, 'permission-denied'],
    [{}, 429, 'rate-limited'],
  ];
  for (const [payload, status, expected] of cases) {
    const gh = fakeGh([{ login: 'alice', active: true }], { alice: FAKE_TOKEN });
    const fake = fakeFetchWithHeaders({ query: () => graphqlResponse(payload, status) });
    const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
    assert.deepEqual(await service.prepare(), { status: 'failed', code: expected });
  }
});

test('gh createDiscussion runs exactly one mutation with the selected account token', async () => {
  const gh = fakeGh([{ login: 'alice', active: true }], { alice: FAKE_TOKEN });
  const fake = fakeFetchWithHeaders({ mutation: () => graphqlResponse(createdPayload()) });
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1234' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].headers.authorization, 'Bearer ' + FAKE_TOKEN);
  assert.doesNotMatch(fake.calls[0].body, /issues/i);
});

test('gh createDiscussion maps an expired token to authorization-expired with exactly one attempt', async () => {
  const gh = fakeGh([{ login: 'alice', active: true }], { alice: FAKE_TOKEN });
  const fake = fakeFetchWithHeaders({ mutation: () => graphqlResponse({}, 401) });
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'authorization-expired' });
  assert.equal(fake.calls.length, 1, 'an expired token must never be retried');
});

test('gh createDiscussion never mutates when the account token cannot be resolved', async () => {
  const gh = fakeGh([{ login: 'alice', active: true }], {});
  const fake = fakeFetchWithHeaders({});
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const outcome = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  assert.deepEqual(outcome, { status: 'failed', code: 'authorization-required' });
  assert.equal(fake.calls.length, 0, 'no mutation may be attempted without a token');
});

test('gh contract: the token never reaches Client payloads, drafts, or outcomes', async () => {
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ], { alice: FAKE_TOKEN });
  const fake = fakeFetchWithHeaders({ query: () => graphqlResponse(preparePayload()) });
  const service = createGitHubService({ ...BASE, ...ghAuthConfig() }, { fetchImpl: fake.impl, gh });
  const selection = await service.prepare();
  const ready = await service.prepare('alice');
  const created = await service.createDiscussion({
    title: 't', body: 'b', categoryId: 'c', repositoryId: 'r', identity: { login: 'alice' },
  });
  const serialized = JSON.stringify({ selection, ready, created });
  assert.ok(!serialized.includes(FAKE_TOKEN), 'the token must never appear in any result payload');
  // The only place the token appears is the Host-to-GitHub fetch header.
  assert.equal(fake.calls[0].headers.authorization, 'Bearer ' + FAKE_TOKEN);
  assert.ok(fake.calls.every((call) => !call.body.includes(FAKE_TOKEN)));
});
