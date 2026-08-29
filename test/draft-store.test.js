import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load, remove, save, resolveDshHome, draftFilePath, DRAFT_SCHEMA_VERSION } from '../lib/draft-store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-store-'));
}

function sampleDraft(overrides = {}) {
  return { title: '标题', scenario: '场景', gap: '缺口', desired: '期望', context: '上下文', ...overrides };
}

test('save writes the minimal record with schema version and updatedAt, load round-trips it', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'draft.json');
    const saved = await save(filePath, sampleDraft());
    assert.equal(saved.version, DRAFT_SCHEMA_VERSION);
    assert.equal(typeof saved.updatedAt, 'string');
    assert.deepEqual(Object.keys(saved).sort(), ['context', 'desired', 'gap', 'scenario', 'title', 'updatedAt', 'version']);

    const loaded = await load(filePath);
    assert.deepEqual(loaded, {
      version: DRAFT_SCHEMA_VERSION,
      title: '标题',
      scenario: '场景',
      gap: '缺口',
      desired: '期望',
      context: '上下文',
      updatedAt: saved.updatedAt,
    });
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

test('POSIX save hard-asserts 0700 on the directory and 0600 on the file', async () => {
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
