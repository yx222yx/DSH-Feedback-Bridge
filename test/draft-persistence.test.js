import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const React = {
  createElement() {
    return { type: null, props: {}, children: [] };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
};

function loadClientExports() {
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  new Function('window', clientBundle)(window);
  assert.ok(registration);
  return registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error('unexpected client require: ' + specifier);
  });
}

function createFakeFetch({ failSaveTimes = 0, failRemove = false } = {}) {
  const log = [];
  let draft = null;
  let saveFails = failSaveTimes;
  return {
    log,
    draft: () => draft,
    async fetch(url, init) {
      log.push({ url, init });
      if (init.method === 'GET') return { ok: true, json: async () => ({ draft }) };
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action === 'save') {
          if (saveFails > 0) {
            saveFails -= 1;
            throw new Error('save boom');
          }
          draft = body.draft;
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (body.action === 'remove') {
          if (failRemove) throw new Error('remove boom');
          draft = null;
          return { ok: true, json: async () => ({ ok: true }) };
        }
      }
      throw new Error('unexpected ' + init.method + ' ' + url);
    },
  };
}

function fields() {
  return { title: '标题', scenario: '场景', gap: '', desired: '期望', context: '' };
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

test('save posts exactly the five draft fields plus the confirmed sources', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });
  const sources = [sampleSource()];
  assert.equal(await persistence.save({ ...fields(), type: 'custom', version: 99 }, sources), true);
  assert.equal(fake.log.length, 1);
  assert.equal(fake.log[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fake.log[0].init.body), { action: 'save', draft: { ...fields(), sources } });
});

test('save omits the sources key when no sources are confirmed', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });
  assert.equal(await persistence.save(fields(), []), true);
  assert.deepEqual(JSON.parse(fake.log[0].init.body), { action: 'save', draft: fields() });
});

test('load resolves fields and sources from a GET and null when empty', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });
  assert.equal(await persistence.load(), null);
  const sources = [sampleSource()];
  await persistence.save(fields(), sources);
  assert.deepEqual(await persistence.load(), { fields: fields(), sources });
});

test('remove posts the remove action and subsequent loads resolve null', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });
  await persistence.save(fields(), []);
  assert.equal(await persistence.remove(), true);
  assert.deepEqual(JSON.parse(fake.log[1].init.body), { action: 'remove' });
  assert.equal(await persistence.load(), null);
});

test('writes are serialized in call order', async () => {
  const moduleExports = loadClientExports();
  const log = [];
  const pending = [];
  const fetchImpl = async (url, init) => {
    log.push({ url, init });
    if (init.method === 'POST' && JSON.parse(init.body).action === 'save') {
      return new Promise((resolve) => pending.push({ resolve }));
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl });

  const first = persistence.save({ ...fields(), title: '第一版' }, []);
  const second = persistence.save({ ...fields(), title: '第二版' }, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(log.length, 1); // the second write waits behind the first

  pending[0].resolve({ ok: true, json: async () => ({ ok: true }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(log.length, 2); // the second write only starts after the first settled

  pending[1].resolve({ ok: true, json: async () => ({ ok: true }) });
  await Promise.all([first, second]);

  assert.deepEqual(JSON.parse(log[0].init.body).draft.title, '第一版');
  assert.deepEqual(JSON.parse(log[1].init.body).draft.title, '第二版');

  // A remove enqueued after the saves runs strictly after them.
  await persistence.remove();
  assert.equal(log.length, 3);
  assert.deepEqual(JSON.parse(log[2].init.body), { action: 'remove' });
});

test('the queue keeps working after a save failure: a later save and remove succeed', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch({ failSaveTimes: 1 });
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });

  await assert.rejects(() => persistence.save(fields(), []), /save boom/);
  assert.equal(await persistence.save({ ...fields(), title: '重试' }, []), true);
  assert.equal(await persistence.remove(), true);
  assert.equal(fake.log.length, 3);
});

test('a save scheduled before a discard is skipped once the discard bumps the generation', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });

  // A stale save is enqueued first, then the discard bumps the generation.
  const stale = persistence.save({ ...fields(), title: '会迟到的保存' }, []);
  const removed = persistence.remove();
  await Promise.all([stale, removed]);

  assert.equal(await stale, false); // skipped, not posted
  assert.equal(fake.log.length, 1);
  assert.deepEqual(JSON.parse(fake.log[0].init.body), { action: 'remove' });
  assert.equal(persistence.generation(), 1);
});

test('the generation bumps on each remove and a later save still succeeds', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });
  assert.equal(persistence.generation(), 0);
  await persistence.remove();
  assert.equal(persistence.generation(), 1);
  assert.equal(await persistence.save(fields(), []), true);
  assert.equal(fake.log.length, 2);
});

test('keepalive posts fields and sources with the keepalive flag and swallows failures', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch({ failSaveTimes: 1 });
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });

  persistence.keepalive(fields(), [sampleSource()]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.log.length, 1);
  assert.equal(fake.log[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(fake.log[0].init.body), { action: 'save', draft: { ...fields(), sources: [sampleSource()] } });

  // A failing keepalive must not throw or reject.
  const failing = createFakeFetch({ failSaveTimes: 1 });
  const persistence2 = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: failing.fetch });
  persistence2.keepalive(fields(), []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failing.log.length, 1);
});

test('keepalive does nothing for a null draft', async () => {
  const moduleExports = loadClientExports();
  const fake = createFakeFetch();
  const persistence = moduleExports.createDraftPersistence({ draftUrl: '/draft', fetchImpl: fake.fetch });
  persistence.keepalive(null, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.log.length, 0);
});
