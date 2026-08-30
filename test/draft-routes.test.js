import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject, name } from '../lib/index.js';
import { draftFilePath, load, DRAFT_SCHEMA_VERSION, MAX_SOURCES } from '../lib/draft-store.js';

function createHarness(dshHome) {
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
  return {
    routes,
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', { get() { return undefined; } });
        ctx.provide('llm', { stream() { return []; } });
        ctx.provide('credentials', {
          async readRecord() { return undefined; },
          async modifyRecord() { return undefined; },
          async deleteRecord() {},
          async describeRecord() { return { configured: false, writable: true }; },
          async listRecords() { return []; },
        });
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

function createRequest({ method = 'GET', body = null } = {}) {
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

function sampleDraft() {
  return { title: '标题', scenario: '场景', gap: '缺口', desired: '期望', context: '上下文' };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-routes-'));
}

test('the draft route returns an empty payload when nothing is persisted', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    assert.ok(route);
    assert.equal(route.kind, 'exact');
    const response = createResponse();
    await route.handler(createRequest({ method: 'GET' }), response);
    assert.equal(response.code, 200);
    assert.deepEqual(JSON.parse(response.body), { draft: null });
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST save persists the draft and GET returns the stored record', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const saveResponse = createResponse();
    await route.handler(createRequest({
      method: 'POST',
      body: JSON.stringify({ action: 'save', draft: sampleDraft() }),
    }), saveResponse);
    assert.equal(saveResponse.code, 200);
    assert.deepEqual(JSON.parse(saveResponse.body), { ok: true });

    const stored = await load(draftFilePath());
    assert.equal(stored.version, DRAFT_SCHEMA_VERSION);
    assert.equal(stored.title, '标题');
    assert.deepEqual(stored.sources, []);
    assert.equal(typeof stored.updatedAt, 'string');

    const readResponse = createResponse();
    await route.handler(createRequest({ method: 'GET' }), readResponse);
    assert.equal(readResponse.code, 200);
    assert.deepEqual(JSON.parse(readResponse.body).draft, stored);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST remove deletes the draft and is idempotent', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    await route.handler(createRequest({ method: 'POST', body: JSON.stringify({ action: 'save', draft: sampleDraft() }) }), createResponse());
    assert.notEqual(await load(draftFilePath()), null);

    const removeResponse = createResponse();
    await route.handler(createRequest({ method: 'POST', body: JSON.stringify({ action: 'remove' }) }), removeResponse);
    assert.equal(removeResponse.code, 200);
    assert.equal(await load(draftFilePath()), null);

    const secondRemove = createResponse();
    await route.handler(createRequest({ method: 'POST', body: JSON.stringify({ action: 'remove' }) }), secondRemove);
    assert.equal(secondRemove.code, 200);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});


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

test('POST save persists confirmed sources and GET returns them', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const sources = [sampleSource(), sampleSource({ id: 'session-1:tool:9', kind: 'tool-result', role: 'tool' })];
    const saveResponse = createResponse();
    await route.handler(createRequest({
      method: 'POST',
      body: JSON.stringify({ action: 'save', draft: { ...sampleDraft(), sources } }),
    }), saveResponse);
    assert.equal(saveResponse.code, 200);

    const stored = await load(draftFilePath());
    assert.deepEqual(stored.sources, sources);

    const readResponse = createResponse();
    await route.handler(createRequest({ method: 'GET' }), readResponse);
    assert.deepEqual(JSON.parse(readResponse.body).draft.sources, sources);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route rejects drafts with invalid sources with 400 and persists nothing', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const invalidBodies = [
      { action: 'save', draft: { ...sampleDraft(), sources: 'nope' } },
      { action: 'save', draft: { ...sampleDraft(), sources: [sampleSource({ role: 'admin' })] } },
      { action: 'save', draft: { ...sampleDraft(), sources: Array.from({ length: MAX_SOURCES + 1 }, (_, i) => sampleSource({ id: 's:' + i })) } },
      { action: 'save', draft: { ...sampleDraft(), sources: [{ id: 'broken' }] } },
    ];
    for (const body of invalidBodies) {
      const response = createResponse();
      await route.handler(createRequest({ method: 'POST', body: JSON.stringify(body) }), response);
      assert.equal(response.code, 400, JSON.stringify(body).slice(0, 120));
    }
    assert.equal(await load(draftFilePath()), null);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route rejects an unsupported action with 400', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const response = createResponse();
    await route.handler(createRequest({ method: 'POST', body: JSON.stringify({ action: 'explode' }) }), response);
    assert.equal(response.code, 400);
    assert.match(JSON.parse(response.body).error, /unsupported action/);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route rejects malformed drafts with 400 and persists nothing', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const invalidDrafts = [
      { action: 'save', draft: { title: '缺少字段' } },
      { action: 'save', draft: { title: 42, scenario: '', gap: '', desired: '', context: '' } },
      { action: 'save', draft: { title: 'x', scenario: '', gap: '', desired: '', context: '', extra: 'y' } },
      { action: 'save', draft: 'not-an-object' },
    ];
    for (const body of invalidDrafts) {
      const response = createResponse();
      await route.handler(createRequest({ method: 'POST', body: JSON.stringify(body) }), response);
      assert.equal(response.code, 400, JSON.stringify(body));
    }
    assert.equal(await load(draftFilePath()), null);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route rejects malformed JSON with 400', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const response = createResponse();
    await route.handler(createRequest({ method: 'POST', body: '{ not json' }), response);
    assert.equal(response.code, 400);
    assert.match(JSON.parse(response.body).error, /valid JSON/);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route rejects an oversized body with 413', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const response = createResponse();
    const huge = JSON.stringify({ action: 'save', draft: sampleDraft() }) + 'x'.repeat(1 << 20);
    await route.handler(createRequest({ method: 'POST', body: huge }), response);
    assert.equal(response.code, 413);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the draft route rejects unexpected methods with 405 and an Allow header', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = createResponse();
      await route.handler(createRequest({ method }), response);
      assert.equal(response.code, 405, method);
      assert.equal(response.headers.allow, 'GET, POST');
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the status payload never carries draft content', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const draftRoute = harness.routes.get('/dsh-feedback-bridge/draft');
    await draftRoute.handler(createRequest({ method: 'POST', body: JSON.stringify({ action: 'save', draft: sampleDraft() }) }), createResponse());

    const statusRoute = harness.routes.get('/dsh-feedback-bridge/status');
    const response = createResponse();
    statusRoute.handler(createRequest({ method: 'GET' }), response);
    const payload = JSON.parse(response.body);
    assert.deepEqual(Object.keys(payload).sort(), ['compatible', 'dshVersion', 'name', 'status', 'version']);
    assert.ok(!JSON.stringify(payload).includes('标题'));
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('a storage failure responds 500 without claiming success', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    // Make the draft target an unwritable directory so both reads and writes fail.
    const filePath = draftFilePath();
    mkdirSync(filePath, { recursive: true });

    const route = harness.routes.get('/dsh-feedback-bridge/draft');
    const saveResponse = createResponse();
    await route.handler(createRequest({ method: 'POST', body: JSON.stringify({ action: 'save', draft: sampleDraft() }) }), saveResponse);
    assert.equal(saveResponse.code, 500);
    assert.deepEqual(JSON.parse(saveResponse.body), { error: 'failed to persist the draft' });

    const readResponse = createResponse();
    await route.handler(createRequest({ method: 'GET' }), readResponse);
    assert.equal(readResponse.code, 500);
    assert.deepEqual(JSON.parse(readResponse.body), { error: 'failed to read the draft' });
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});
