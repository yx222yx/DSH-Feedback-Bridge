import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load, remove, save, resolveDshHome, draftFilePath, DRAFT_SCHEMA_VERSION, MAX_SOURCES, MAX_SOURCE_TEXT } from '../lib/draft-store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-store-'));
}

function sampleDraft(overrides = {}) {
  return { title: '标题', scenario: '场景', gap: '缺口', desired: '期望', context: '上下文', ...overrides };
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

test('save writes the minimal v2 record (five fields, empty sources, version, updatedAt) and load round-trips it', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const saved = await save(filePath, sampleDraft());
    assert.equal(saved.version, DRAFT_SCHEMA_VERSION);
    assert.equal(typeof saved.updatedAt, 'string');
    assert.deepEqual(Object.keys(saved).sort(), ['context', 'desired', 'gap', 'scenario', 'sources', 'title', 'type', 'updatedAt', 'version']);

    const loaded = await load(filePath);
    assert.deepEqual(loaded, {
      version: DRAFT_SCHEMA_VERSION,
      title: '标题',
      scenario: '场景',
      gap: '缺口',
      desired: '期望',
      context: '上下文',
      sources: [],
      type: 'custom',
      updatedAt: saved.updatedAt,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save persists confirmed sources and load round-trips them verbatim', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const sources = [
      sampleSource(),
      sampleSource({
        id: 'session-1:tool:call-9',
        kind: 'tool-result',
        role: 'tool',
        label: '工具输出：bash',
        text: 'SENTINEL_DIAG_RAW',
        sensitive: true,
      }),
    ];
    const saved = await save(filePath, sampleDraft({ title: '带来源' }), sources);
    assert.deepEqual(saved.sources, sources);
    const loaded = await load(filePath);
    assert.equal(loaded.title, '带来源');
    assert.deepEqual(loaded.sources, sources);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save creates the missing parent directory recursively', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'nested', 'dir', 'draft.json');
    await save(filePath, sampleDraft());
    assert.equal((await load(filePath)).title, '标题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POSIX save hard-asserts 0700 on the directory and 0600 on the file', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'sub', 'draft.json');
    await save(filePath, sampleDraft());
    const dirMode = statSync(join(dir, 'sub')).mode & 0o777;
    const fileMode = statSync(filePath).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic save replaces the previous record and leaves no temp files behind', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    await save(filePath, sampleDraft({ title: '第一版' }));
    await save(filePath, sampleDraft({ title: '第二版' }));
    assert.equal((await load(filePath)).title, '第二版');
    const leftovers = readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load returns null when the draft file does not exist', async () => {
  const dir = tempDir();
  try {
    assert.equal(await load(join(dir, 'missing', 'draft.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load isolates a corrupt JSON file instead of silently discarding it', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    writeFileSync(filePath, '{ not json', 'utf8');
    assert.equal(await load(filePath), null);
    const isolated = readdirSync(dir).filter((entry) => entry.startsWith('draft.json.corrupt-'));
    assert.equal(isolated.length, 1);
    assert.equal(readFileSync(join(dir, isolated[0]), 'utf8'), '{ not json');
    assert.equal(await load(filePath), null); // original path is gone
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load isolates an unknown-version record and returns null', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    writeFileSync(filePath, JSON.stringify({ version: 99, title: 'x' }), 'utf8');
    assert.equal(await load(filePath), null);
    const isolated = readdirSync(dir).filter((entry) => entry.startsWith('draft.json.corrupt-'));
    assert.equal(isolated.length, 1);
    assert.equal((await load(filePath)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load isolates a record with missing or wrong-typed fields', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    writeFileSync(filePath, JSON.stringify({ version: 1, title: 42, scenario: '', gap: '', desired: '', context: '' }), 'utf8');
    assert.equal(await load(filePath), null);
    assert.equal(readdirSync(dir).filter((entry) => entry.startsWith('draft.json.corrupt-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save rejects a draft whose fields are not all strings', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    await assert.rejects(() => save(filePath, { title: 42, scenario: '', gap: '', desired: '', context: '' }), /draft field .* must be a string/);
    await assert.rejects(() => save(filePath, { title: 'x' }), /draft field .* must be a string/);
    assert.equal(await load(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load migrates a version-1 record in memory to version 2 with empty sources, keeping the file untouched until the next save', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const v1 = {
      version: 1,
      title: '旧版标题',
      scenario: '旧场景',
      gap: '旧缺口',
      desired: '旧期望',
      context: '旧上下文',
      updatedAt: '2025-06-01T00:00:00.000Z',
    };
    writeFileSync(filePath, JSON.stringify(v1), 'utf8');

    const loaded = await load(filePath);
    assert.equal(loaded.version, DRAFT_SCHEMA_VERSION);
    assert.deepEqual(loaded.sources, []);
    assert.equal(loaded.title, '旧版标题');
    assert.equal(loaded.updatedAt, v1.updatedAt);
    // The on-disk file is not rewritten by a read; the next save persists v2.
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 1);

    await save(filePath, { title: '新版', scenario: '', gap: '', desired: '', context: '' });
    const after = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(after.version, DRAFT_SCHEMA_VERSION);
    assert.deepEqual(after.sources, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save rejects sources beyond the per-draft cap', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const tooMany = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => sampleSource({ id: 's:' + index }));
    await assert.rejects(() => save(filePath, sampleDraft(), tooMany), /sources/);
    assert.equal(await load(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save rejects a malformed source record', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    await assert.rejects(
      () => save(filePath, sampleDraft(), [sampleSource({ role: 'admin' })]),
      /source .* role/,
    );
    await assert.rejects(
      () => save(filePath, sampleDraft(), [sampleSource({ kind: 'mystery' })]),
      /source .* kind/,
    );
    await assert.rejects(
      () => save(filePath, sampleDraft(), [sampleSource({ truncated: 'yes' })]),
      /source .* truncated/,
    );
    await assert.rejects(
      () => save(filePath, sampleDraft(), [sampleSource({ text: 'x'.repeat(MAX_SOURCE_TEXT + 1) })]),
      /source .* text/,
    );
    await assert.rejects(
      () => save(filePath, sampleDraft(), [sampleSource({ sessionId: '' })]),
      /source .* sessionId/,
    );
    await assert.rejects(
      () => save(filePath, sampleDraft(), [sampleSource({ extra: true })]),
      /source .* keys/,
    );
    assert.equal(await load(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save rejects sources that are not an array', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    await assert.rejects(() => save(filePath, sampleDraft(), 'not-an-array'), /sources/);
    await assert.rejects(() => save(filePath, sampleDraft(), { 0: sampleSource() }), /sources/);
    assert.equal(await load(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load isolates a version-2 record with an invalid sources array', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const v2 = {
      version: 2,
      title: 'x',
      scenario: '',
      gap: '',
      desired: '',
      context: '',
      sources: [{ id: 'broken', sessionId: '' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(filePath, JSON.stringify(v2), 'utf8');
    assert.equal(await load(filePath), null);
    assert.equal(readdirSync(dir).filter((entry) => entry.startsWith('draft.json.corrupt-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove deletes the draft file and is idempotent for a missing file', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    await save(filePath, sampleDraft());
    await remove(filePath);
    assert.equal(await load(filePath), null);
    await remove(filePath); // no throw
    assert.equal(await load(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDshHome prefers DSH_HOME and falls back to the default under the OS home', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/custom-home';
  try {
    assert.equal(resolveDshHome(), '/tmp/custom-home');
    assert.equal(draftFilePath(), join('/tmp/custom-home', 'dsh-feedback-bridge', 'draft.json'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
  assert.ok(resolveDshHome().endsWith(join('.dsh')));
});

test('resolveDshHome treats a blank DSH_HOME as unset', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '   ';
  try {
    assert.ok(resolveDshHome().endsWith(join('.dsh')));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('save persists the feedback type and language and load round-trips them', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const saved = await save(filePath, sampleDraft(), [], { type: 'harness-defect', language: 'zh' });
    assert.equal(saved.type, 'harness-defect');
    assert.equal(saved.language, 'zh');
    const loaded = await load(filePath);
    assert.equal(loaded.type, 'harness-defect');
    assert.equal(loaded.language, 'zh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save defaults the feedback type to custom and omits an unset language', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const saved = await save(filePath, sampleDraft());
    assert.equal(saved.type, 'custom');
    assert.equal('language' in saved, false);
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(raw.type, 'custom');
    assert.equal('language' in raw, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save rejects an invalid feedback type or language', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    await assert.rejects(() => save(filePath, sampleDraft(), [], { type: 'mystery' }), /feedback type/);
    await assert.rejects(() => save(filePath, sampleDraft(), [], { type: 'custom', language: 'fr' }), /language/);
    assert.equal(await load(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load migrates a version-2 record to version 3 with the custom type and an unset language', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const v2 = {
      version: 2,
      title: '旧版',
      scenario: '',
      gap: '',
      desired: '',
      context: '',
      sources: [sampleSource()],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(filePath, JSON.stringify(v2), 'utf8');
    const loaded = await load(filePath);
    assert.equal(loaded.version, DRAFT_SCHEMA_VERSION);
    assert.equal(loaded.type, 'custom');
    assert.equal('language' in loaded, false);
    assert.deepEqual(loaded.sources, v2.sources);
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 2); // not rewritten by a read
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load migrates a version-1 record to version 3 with empty sources and the custom type', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const v1 = {
      version: 1,
      title: '更旧',
      scenario: '',
      gap: '',
      desired: '',
      context: '',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    writeFileSync(filePath, JSON.stringify(v1), 'utf8');
    const loaded = await load(filePath);
    assert.equal(loaded.version, DRAFT_SCHEMA_VERSION);
    assert.equal(loaded.type, 'custom');
    assert.deepEqual(loaded.sources, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load isolates a version-3 record with an invalid feedback type', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    writeFileSync(filePath, JSON.stringify({
      version: 3,
      title: 'x',
      scenario: '',
      gap: '',
      desired: '',
      context: '',
      sources: [],
      type: 'mystery',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8');
    assert.equal(await load(filePath), null);
    assert.equal(readdirSync(dir).filter((entry) => entry.startsWith('draft.json.corrupt-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

