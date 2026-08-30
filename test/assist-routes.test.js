import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject, name } from '../lib/index.js';
import { load, draftFilePath } from '../lib/draft-store.js';

/** A known-good literal model result; the independent source of truth. */
const VALID_RESULT = {
  type: 'harness-defect',
  typeReason: 'Observable harness failure.',
  missingInfo: [{ field: 'reproduction', reason: 'Missing repro steps.', importance: 'high' }],
  draft: {
    title: 'Harness crashes on plugin load',
    scenario: 'It crashed.',
    gap: 'No message.',
    desired: 'Stay running.',
    context: '',
  },
  privacyFindings: [],
};

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function failedFinish(code, message) {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }];
}

function sampleSource(overrides = {}) {
  return {
    id: 'session-1:user:3',
    sessionId: 'session-1',
    kind: 'message',
    role: 'user',
    label: '用户消息',
    text: 'SENTINEL_CONFIRMED',
    truncated: false,
    sensitive: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createHarness(dshHome, options = {}) {
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
  let currentChunks = [];
  let streamCalls = 0;
  const appended = [];
  const fakeSession = {
    requestHeader() {
      return options.header;
    },
    append(type, data) {
      appended.push({ type, data });
    },
  };
  const sessions = {
    get(id) {
      return options.liveSessionId === id ? fakeSession : undefined;
    },
  };
  const llm = {
    stream() {
      streamCalls += 1;
      return currentChunks;
    },
  };
  return {
    routes,
    appended,
    setChunks(chunks) {
      currentChunks = chunks;
    },
    streamCalls() {
      return streamCalls;
    },
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', sessions);
        ctx.provide('llm', llm);
      });
      await provider;
      const previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = dshHome;
      const previousVersion = process.env.DSH_VERSION;
      process.env.DSH_VERSION = '0.1.1-rc.2';
      const fiber = context.plugin({ name, inject, apply });
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

function createRequest({ method = 'POST', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(body)];
  return {
    method,
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

function validBody(overrides = {}) {
  return {
    sessionId: 'session-1',
    language: null,
    currentType: 'custom',
    sources: [sampleSource()],
    ...overrides,
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-assist-routes-'));
}

const HEADER = { config: { provider: 'deepseek-official', model: 'deepseek-chat' } };

test('the assist route is registered and refuses methods other than POST', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    assert.ok(route);
    assert.equal(route.kind, 'exact');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = createResponse();
      await route.handler(createRequest({ method }), response);
      assert.equal(response.code, 405, method);
      assert.equal(response.headers.allow, 'POST');
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST assist returns a validated ok result from a fake structured stream', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    harness.setChunks(textChunks(JSON.stringify(VALID_RESULT)));
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    const response = createResponse();
    await route.handler(createRequest({ body: JSON.stringify(validBody()) }), response);
    assert.equal(response.code, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.result.type, 'harness-defect');
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST assist returns repair-needed preserving the raw text for unparseable output', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    harness.setChunks(textChunks('this is not json'));
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    const response = createResponse();
    await route.handler(createRequest({ body: JSON.stringify(validBody()) }), response);
    assert.equal(response.code, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.status, 'repair-needed');
    assert.equal(payload.rawText, 'this is not json');
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST assist returns model-failed with the provider failure code', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    harness.setChunks(failedFinish('RATE_LIMIT', 'slow down'));
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    const response = createResponse();
    await route.handler(createRequest({ body: JSON.stringify(validBody()) }), response);
    const payload = JSON.parse(response.body);
    assert.equal(payload.status, 'model-failed');
    assert.equal(payload.code, 'RATE_LIMIT');
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST assist returns no-model-context when the session has no request header and never calls the model', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: undefined, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    const response = createResponse();
    await route.handler(createRequest({ body: JSON.stringify(validBody()) }), response);
    const payload = JSON.parse(response.body);
    assert.equal(payload.status, 'no-model-context');
    assert.equal(harness.streamCalls(), 0);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST assist rejects invalid request bodies with 400', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    const invalidBodies = [
      validBody({ sessionId: '' }),
      validBody({ sessionId: 42 }),
      validBody({ language: 'fr' }),
      validBody({ currentType: 'mystery' }),
      validBody({ sources: 'nope' }),
      validBody({ sources: [sampleSource({ role: 'admin' })] }),
      'not-an-object',
    ];
    for (const body of invalidBodies) {
      const response = createResponse();
      await route.handler(createRequest({ body: typeof body === 'string' ? body : JSON.stringify(body) }), response);
      assert.equal(response.code, 400, JSON.stringify(body).slice(0, 120));
    }
    assert.equal(harness.streamCalls(), 0);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the assist call records a session event carrying the model-visible envelope', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    harness.setChunks(textChunks(JSON.stringify(VALID_RESULT)));
    const route = harness.routes.get('/dsh-feedback-bridge/assist');
    const response = createResponse();
    await route.handler(createRequest({ body: JSON.stringify(validBody({ language: 'zh', currentType: 'harness-feature' })) }), response);
    assert.equal(response.code, 200);
    assert.equal(harness.appended.length, 1);
    const [record] = harness.appended;
    assert.equal(record.type, 'dsh-feedback-bridge/assist');
    assert.equal(record.data.outcome, 'ok');
    assert.equal(record.data.provider, 'deepseek-official');
    assert.equal(record.data.model, 'deepseek-chat');
    assert.equal(record.data.language, 'zh');
    assert.equal(record.data.currentType, 'harness-feature');
    assert.deepEqual(record.data.sourceIds, ['session-1:user:3']);
    assert.match(record.data.sourcesText, /SENTINEL_CONFIRMED/);
    assert.match(record.data.systemText, /Language: zh/);
    assert.equal(typeof record.data.at, 'string');
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route persists the feedback type and language and rejects invalid values', async () => {
  const home = tempHome();
  const harness = createHarness(home, { header: HEADER, liveSessionId: 'session-1' });
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const saveResponse = createResponse();
    await route.handler(createRequest({
      method: 'POST',
      body: JSON.stringify({
        action: 'save',
        draft: { title: 't', scenario: '', gap: '', desired: '', context: '', type: 'plugin-request', language: 'zh' },
      }),
    }), saveResponse);
    assert.equal(saveResponse.code, 200);
    const stored = await load(draftFilePath());
    assert.equal(stored.type, 'plugin-request');
    assert.equal(stored.language, 'zh');

    for (const bad of [{ type: 'mystery' }, { language: 'fr' }]) {
      const response = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify({ action: 'save', draft: { title: 't', scenario: '', gap: '', desired: '', context: '', ...bad } }),
      }), response);
      assert.equal(response.code, 400, JSON.stringify(bad));
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});
