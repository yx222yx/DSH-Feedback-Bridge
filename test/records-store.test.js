import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendRecord, loadRecords, recordsFilePath, RECORDS_SCHEMA_VERSION } from '../lib/records.js';
import { draftFilePath, save as saveDraft, load as loadDraft } from '../lib/draft-store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-records-'));
}

function sampleInput(overrides = {}) {
  return {
    title: 'Export a plugin draft',
    url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/4242',
    account: 'fake-user',
    ...overrides,
  };
}

test('appendRecord writes one immutable record and loadRecords round-trips it', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'records.json');
    const saved = await appendRecord(filePath, sampleInput());
    assert.equal(typeof saved.id, 'string');
    assert.ok(saved.id !== '');
    assert.equal(saved.title, 'Export a plugin draft');
    assert.equal(saved.url, 'https://github.com/deepseek-ai/deepseek-harness/discussions/4242');
    assert.equal(saved.account, 'fake-user');
    assert.equal(typeof saved.submittedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(saved.submittedAt)));

    const loaded = await loadRecords(filePath);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], saved);
    // The on-disk wrapper carries exactly the schema version and the record list.
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(raw.version, RECORDS_SCHEMA_VERSION);
    assert.deepEqual(raw.records, [saved]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRecord is append-only: later records never overwrite earlier ones', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'records.json');
    const first = await appendRecord(filePath, sampleInput({ title: '第一版' }));
    const second = await appendRecord(filePath, sampleInput({ title: '第二版' }));
    const loaded = await loadRecords(filePath);
    assert.deepEqual(loaded, [first, second]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRecords returns an empty list when the records file does not exist', async () => {
  const dir = tempDir();
  try {
    assert.deepEqual(await loadRecords(join(dir, 'missing', 'records.json')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRecords isolates a corrupt JSON file and returns an empty list', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'records.json');
    writeFileSync(filePath, '{ not json', 'utf8');
    assert.deepEqual(await loadRecords(filePath), []);
    const isolated = readdirSync(dir).filter((entry) => entry.startsWith('records.json.corrupt-'));
    assert.equal(isolated.length, 1);
    assert.equal(readFileSync(join(dir, isolated[0]), 'utf8'), '{ not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRecords isolates an unknown-version wrapper and returns an empty list', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'records.json');
    writeFileSync(filePath, JSON.stringify({ version: 99, records: [] }), 'utf8');
    assert.deepEqual(await loadRecords(filePath), []);
    assert.equal(readdirSync(dir).filter((entry) => entry.startsWith('records.json.corrupt-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRecords isolates a record carrying extra or wrong-typed fields', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'records.json');
    const base = { version: RECORDS_SCHEMA_VERSION, records: [sampleInput()] };
    const cases = [
      { ...base, records: [{ ...sampleInput(), token: 'gho_secret' }] },
      { ...base, records: [{ ...sampleInput(), title: 42 }] },
      { ...base, records: [{ ...sampleInput(), url: 'not a url' }] },
      { ...base, records: [{ ...sampleInput(), account: '' }] },
    ];
    for (const payload of cases) {
      writeFileSync(filePath, JSON.stringify(payload), 'utf8');
      assert.deepEqual(await loadRecords(filePath), [], 'records with foreign or malformed fields must not load');
    }
    // Every malformed attempt quarantined the file; the original path is gone.
    assert.equal(await loadRecords(filePath).then((records) => records.length), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POSIX appendRecord hard-asserts 0700 on the directory and 0600 on the file', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'sub', 'records.json');
    await appendRecord(filePath, sampleInput());
    const dirMode = statSync(join(dir, 'sub')).mode & 0o777;
    const fileMode = statSync(filePath).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records storage is separate from the recoverable draft: each file is untouched by the other', async () => {
  const dir = tempDir();
  try {
    const recordsPath = join(dir, 'records.json');
    const draftPath = join(dir, 'draft.json');

    // Draft writes never create or touch the records file.
    await saveDraft(draftPath, { title: '草稿', scenario: '', gap: '', desired: '', context: '' });
    assert.deepEqual(await loadRecords(recordsPath), []);
    assert.equal(readdirSync(dir).filter((entry) => entry === 'records.json').length, 0);

    // Record appends never touch the draft file.
    await appendRecord(recordsPath, sampleInput());
    const draft = await loadDraft(draftPath);
    assert.equal(draft.title, '草稿');
    assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).version, 3);

    // Discarding the draft leaves the records intact.
    await saveDraft(draftPath, { title: '草稿', scenario: '', gap: '', desired: '', context: '' }, [], { type: 'custom' });
    const records = await loadRecords(recordsPath);
    assert.equal(records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRecord rejects an invalid record input without writing anything', async () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, 'records.json');
    await assert.rejects(() => appendRecord(filePath, sampleInput({ title: '' })), /title/);
    await assert.rejects(() => appendRecord(filePath, sampleInput({ title: '   ' })), /title/);
    await assert.rejects(() => appendRecord(filePath, sampleInput({ url: 'ftp://nope' })), /url/);
    await assert.rejects(() => appendRecord(filePath, sampleInput({ url: '' })), /url/);
    await assert.rejects(() => appendRecord(filePath, sampleInput({ account: '' })), /account/);
    assert.equal(readdirSync(dir).filter((entry) => entry === 'records.json').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordsFilePath resolves under the harness home next to the draft', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/custom-home';
  try {
    assert.equal(recordsFilePath(), join('/tmp/custom-home', 'dsh-feedback-bridge', 'records.json'));
    assert.notEqual(recordsFilePath(), draftFilePath());
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
