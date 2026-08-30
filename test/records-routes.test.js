import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject, name } from '../lib/index.js';

/** GraphQL-shaped payload with the pinned official repo and two categories. */
const REPO_PAYLOAD = {
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
};

const DISCUSSION_URL = 'https://github.com/deepseek-ai/deepseek-harness/discussions/4242';
/** Sentinel that must never appear in any persisted record. */
const BODY_SENTINEL = 'BODY_SENTINEL_PRIVATE_CONTENT';
const TOKEN_SENTINEL = 'gho_records-route-secret';

/**
 * Start a local fake GitHub GraphQL server that records every request and
 * answers per scenario. mutationMode controls the CreateDiscussion response:
 * ok (URL), hang (record then never respond -> unknown), or an HTTP/error
 * class.
 */
function startFakeGitHub({ mutationMode = 'ok' } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      const match = /(query|mutation)\s+(\w+)/.exec(body);
      const operation = match === null ? 'unknown' : match[2];
      if (operation === 'PrepareSubmission') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(REPO_PAYLOAD));
        return;
      }
      if (operation === 'CreateDiscussion') {
        if (mutationMode === 'hang') return; // record but never respond
        if (mutationMode === 'rate-limited') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (mutationMode === 'auth-required') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (mutationMode === 'network') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const payload = mutationMode === 'forbidden'
          ? { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }
          : mutationMode === 'validation'
            ? { errors: [{ type: 'VALIDATION', message: 'Title is invalid' }] }
            : { data: { createDiscussion: { discussion: { url: DISCUSSION_URL } } } };
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const base = 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port);
      resolve({ server, requests, base });
    });
  });
}

/** Mutation-count helper: requests whose body carries the CreateDiscussion operation. */
function mutationRequests(requests) {
  return requests.filter((request) => /mutation\s+CreateDiscussion/.test(request.body));
}

/** Plugin harness with the webServer/sessions/llm services and a plugin config. */
function createHarness(dshHome, config) {
  const routes = new Map();
  const context = new Context();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => {
        routes.delete(route.path);
      };
    },
  };
  const sessions = { get() { return undefined; } };
  const llm = { stream() { throw new Error('unused'); } };
  const credentials = {
    async readRecord() { return undefined; },
    async modifyRecord() { return undefined; },
    async deleteRecord() {},
    async describeRecord() { return { configured: false, writable: true }; },
    async listRecords() { return []; },
  };
  return {
    routes,
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', sessions);
        ctx.provide('llm', llm);
        ctx.provide('credentials', credentials);
      });
      await provider;
      const previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = dshHome;
      const previousVersion = process.env.DSH_VERSION;
      process.env.DSH_VERSION = '0.1.1-rc.2';
      const fiber = context.plugin({ name, inject, apply }, config);
      await fiber;
      return {
        fiber,
        restore() {
          if (previousHome === undefined) delete process.env.DSH_HOME;
          else process.env.DSH_HOME = previousHome;
          if (previousVersion === undefined) delete process.env.DSH_VERSION;
          else process.env.DSH_VERSION = previousVersion;
        },
      };
    },
  };
}

function createRequest({ method = 'GET', body = null, url = '/dsh-feedback-bridge/records' } = {}) {
  const chunks = body === null ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    resume() {},
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async () => (index < chunks.length
          ? { value: chunks[index++], done: false }
          : { value: undefined, done: true }),
      };
    },
  };
}

function createResponse() {
  return {
    code: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function fakeAuthConfig(base, extra = {}) {
  return {
    github: {
      graphqlEndpoint: base + '/graphql',
      timeoutMs: 300,
      auth: { provider: 'fake', identity: { login: 'fake-user' } },
      ...extra,
    },
  };
}

function confirmBody(overrides = {}) {
  return {
    preparedId: 'nonce-1',
    title: 'Export a plugin draft',
    body: '# Export a plugin draft\n\n' + BODY_SENTINEL,
    categoryId: 'DIC_ideas',
    ...overrides,
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-records-routes-'));
}

/** Records file path for the given harness home. */
function recordsFile(home) {
  return join(home, 'dsh-feedback-bridge', 'records.json');
}

/** Run one full successful submission through the harness routes. */
async function submitSuccessfully(route, responseFactory = createResponse) {
  const prepare = responseFactory();
  await route.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
  const prepared = JSON.parse(prepare.body);
  assert.equal(prepared.status, 'ready');
  const confirm = responseFactory();
  await route.handler(createRequest({
    method: 'POST',
    url: '/dsh-feedback-bridge/submission',
    body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
  }), confirm);
  assert.deepEqual(JSON.parse(confirm.body), { status: 'created', url: DISCUSSION_URL });
  return { prepared, confirm };
}

test('the records route is registered, GETs the record list, and refuses other methods', async () => {
  const home = tempHome();
  const harness = createHarness(home, fakeAuthConfig('http://127.0.0.1:1'));
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/records');
    assert.ok(route);
    assert.equal(route.kind, 'exact');
    const response = createResponse();
    await route.handler(createRequest(), response);
    assert.equal(response.code, 200);
    assert.deepEqual(JSON.parse(response.body), { records: [] });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = createResponse();
      await route.handler(createRequest({ method }), refused);
      assert.equal(refused.code, 405, method);
      assert.equal(refused.headers.allow, 'GET');
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('a confirmed successful submission appends exactly one record with title, url, time, and account', async () => {
  const fake = await startFakeGitHub();
  try {
    const home = tempHome();
    const harness = createHarness(home, fakeAuthConfig(fake.base));
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      await submitSuccessfully(route);

      const list = createResponse();
      await harness.routes.get('/dsh-feedback-bridge/records').handler(createRequest(), list);
      const payload = JSON.parse(list.body);
      assert.equal(payload.records.length, 1);
      const record = payload.records[0];
      assert.equal(record.title, 'Export a plugin draft');
      assert.equal(record.url, DISCUSSION_URL);
      assert.equal(record.account, 'fake-user');
      assert.ok(typeof record.id === 'string' && record.id !== '');
      assert.ok(typeof record.submittedAt === 'string' && !Number.isNaN(Date.parse(record.submittedAt)));

      // The record is durably on disk under the harness home.
      const onDisk = JSON.parse(readFileSync(recordsFile(home), 'utf8'));
      assert.equal(onDisk.records.length, 1);
      assert.deepEqual(onDisk.records[0], record);
      assert.equal(mutationRequests(fake.requests).length, 1);
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('failed, unknown, category-unavailable, and replayed confirms never create a record', async () => {
  const failureModes = [
    ['rate-limited', 'rate-limited'],
    ['auth-required', 'authorization-required'],
    ['network', 'network'],
    ['forbidden', 'permission-denied'],
    ['validation', 'validation-rejected'],
  ];
  for (const [mode, code] of failureModes) {
    const fake = await startFakeGitHub({ mutationMode: mode });
    try {
      const home = tempHome();
      const harness = createHarness(home, fakeAuthConfig(fake.base));
      const { fiber, restore } = await harness.load();
      try {
        const route = harness.routes.get('/dsh-feedback-bridge/submission');
        const prepare = createResponse();
        await route.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
        const prepared = JSON.parse(prepare.body);
        const confirm = createResponse();
        await route.handler(createRequest({
          method: 'POST',
          url: '/dsh-feedback-bridge/submission',
          body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
        }), confirm);
        assert.deepEqual(JSON.parse(confirm.body), { status: 'failed', code }, mode);

        const list = createResponse();
        await harness.routes.get('/dsh-feedback-bridge/records').handler(createRequest(), list);
        assert.deepEqual(JSON.parse(list.body), { records: [] }, mode + ' must not create a record');
      } finally {
        restore();
        await fiber.dispose().catch(() => {});
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      fake.server.close();
    }
  }

  // Unknown result: dispatched but no definitive response -> no record.
  const unknownFake = await startFakeGitHub({ mutationMode: 'hang' });
  try {
    const home = tempHome();
    const harness = createHarness(home, fakeAuthConfig(unknownFake.base));
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const prepare = createResponse();
      await route.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
      const prepared = JSON.parse(prepare.body);
      const confirm = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        url: '/dsh-feedback-bridge/submission',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
      }), confirm);
      assert.deepEqual(JSON.parse(confirm.body), { status: 'unknown' });
      const list = createResponse();
      await harness.routes.get('/dsh-feedback-bridge/records').handler(createRequest(), list);
      assert.deepEqual(JSON.parse(list.body), { records: [] }, 'unknown must not create a record');
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    unknownFake.server.close();
  }

  // Unknown category: refused before any mutation -> no record.
  const categoryFake = await startFakeGitHub();
  try {
    const home = tempHome();
    const harness = createHarness(home, fakeAuthConfig(categoryFake.base));
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const prepare = createResponse();
      await route.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
      const prepared = JSON.parse(prepare.body);
      const confirm = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        url: '/dsh-feedback-bridge/submission',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId, categoryId: 'DIC_mystery' })),
      }), confirm);
      assert.deepEqual(JSON.parse(confirm.body), { status: 'failed', code: 'category-unavailable' });
      const list = createResponse();
      await harness.routes.get('/dsh-feedback-bridge/records').handler(createRequest(), list);
      assert.deepEqual(JSON.parse(list.body), { records: [] }, 'category-unavailable must not create a record');
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    categoryFake.server.close();
  }

  // A replayed nonce is refused with 409 and never appends twice.
  const replayFake = await startFakeGitHub();
  try {
    const home = tempHome();
    const harness = createHarness(home, fakeAuthConfig(replayFake.base));
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const prepared = (await submitSuccessfully(route)).prepared;
      const second = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        url: '/dsh-feedback-bridge/submission',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
      }), second);
      assert.equal(second.code, 409);
      const list = createResponse();
      await harness.routes.get('/dsh-feedback-bridge/records').handler(createRequest(), list);
      assert.equal(JSON.parse(list.body).records.length, 1, 'one confirmation may append at most one record');
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    replayFake.server.close();
  }
});

test('persisted records carry no body content, credentials, or draft data', async () => {
  const fake = await startFakeGitHub();
  try {
    const home = tempHome();
    const harness = createHarness(home, fakeAuthConfig(fake.base));
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      await submitSuccessfully(route);

      const onDisk = readFileSync(recordsFile(home), 'utf8');
      assert.match(onDisk, /Export a plugin draft/);
      assert.match(onDisk, /fake-user/);
      assert.doesNotMatch(onDisk, /BODY_SENTINEL|# Export a plugin draft/);
      assert.doesNotMatch(onDisk, /TOKEN_SENTINEL|gho_/);

      // Draft writes never leak into the records file and vice versa.
      const draftRoute = harness.routes.get('/dsh-feedback-bridge/draft');
      const draftSave = createResponse();
      await draftRoute.handler(createRequest({
        method: 'POST',
        url: '/dsh-feedback-bridge/draft',
        body: JSON.stringify({
          action: 'save',
          draft: { title: 'DRAFT_TITLE_SENTINEL', scenario: '', gap: '', desired: '', context: '' },
          type: 'custom',
        }),
      }), draftSave);
      assert.equal(draftSave.code, 200);
      const recordsStill = readFileSync(recordsFile(home), 'utf8');
      assert.doesNotMatch(recordsStill, /DRAFT_TITLE_SENTINEL/);
      const draftStill = readFileSync(join(home, 'dsh-feedback-bridge', 'draft.json'), 'utf8');
      assert.match(draftStill, /DRAFT_TITLE_SENTINEL/);
      assert.doesNotMatch(draftStill, /Export a plugin draft/);
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});
