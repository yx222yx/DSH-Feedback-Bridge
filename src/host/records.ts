import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { resolveDshHome } from './draft-store.js';

/**
 * On-disk schema version of the persisted submission-records file. Bump on
 * any incompatible change to the stored wrapper or record; unknown versions
 * are quarantined by {@link loadRecords} rather than interpreted.
 */
export const RECORDS_SCHEMA_VERSION = 1;

/**
 * One immutable local submission record (Issue #11): the public title, the
 * permanent Discussion URL, the submission time, the submission account
 * identity, and the local reference id. It deliberately carries nothing
 * else — no body, no sources, no tokens, no diagnostics — so a stored record
 * never leaks credentials or raw feedback content.
 */
export interface StoredSubmissionRecord {
  id: string;
  title: string;
  url: string;
  submittedAt: string;
  account: string;
}

/** The caller-supplied fields of a new record; the store stamps id and submittedAt. */
export interface SubmissionRecordInput {
  title: string;
  url: string;
  account: string;
}

/** The exact key roster a stored record must carry. */
const RECORD_KEYS = ['id', 'title', 'url', 'submittedAt', 'account'] as const;

/**
 * True on native Windows. POSIX permission guarantees (0600/0700) are
 * hard-asserted only here; Windows carries no equivalent ACL claim.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Absolute path of the persisted submission-records file under the harness
 * home: `<DSH_HOME>/dsh-feedback-bridge/records.json`. Deliberately a
 * sibling of the recoverable draft file, never the same file.
 *
 * @param dshHome - harness home; defaults to resolveDshHome().
 * @returns the records file path.
 */
export function recordsFilePath(dshHome: string = resolveDshHome()): string {
  return join(dshHome, 'dsh-feedback-bridge', 'records.json');
}

/**
 * Assert one parsed value is a valid stored record, naming the first
 * invalid aspect. The durable-file boundary enforces the exact five-field
 * contract so a record with extra keys (tokens, sources, diagnostics) or
 * malformed values never loads.
 *
 * @param entry - one candidate record.
 * @param index - position inside the records array, for the error message.
 * @throws {Error} naming the first invalid field.
 */
function assertRecord(entry: unknown, index: number): asserts entry is StoredSubmissionRecord {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('record ' + index + ' must be an object');
  }
  const candidate = entry as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== RECORD_KEYS.length
    || RECORD_KEYS.some((key) => !(key in candidate))
  ) {
    throw new Error('record ' + index + ' must contain exactly the keys: ' + RECORD_KEYS.join(', '));
  }
  for (const key of RECORD_KEYS) {
    if (typeof candidate[key] !== 'string' || candidate[key].trim() === '') {
      throw new Error('record ' + index + ' field ' + key + ' must be a non-empty string');
    }
  }
  const url = candidate.url as string;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('record ' + index + ' url must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('record ' + index + ' url must use http or https');
  }
}

/**
 * Validate the caller-supplied record fields; the wire boundary fails loud
 * before anything is written.
 *
 * @param input - record fields to persist.
 * @throws {Error} naming the first invalid field.
 */
function assertRecordInput(input: SubmissionRecordInput): asserts input is SubmissionRecordInput {
  const candidate: Record<string, unknown> = {
    title: input.title,
    url: input.url,
    account: input.account,
  };
  assertRecord({ id: 'pending', ...candidate, submittedAt: 'pending' }, 0);
}

/**
 * Hard-assert a POSIX permission on a path; a no-op on Windows, which has no
 * equivalent mode guarantees.
 *
 * @param filePath - path to stat.
 * @param expected - expected mode such as 0o600.
 * @returns void.
 * @throws {Error} when the stat mode differs from the expectation.
 */
async function assertPosixMode(filePath: string, expected: number): Promise<void> {
  if (isWindows()) return;
  const mode = (await stat(filePath)).mode & 0o777;
  if (mode !== expected) {
    throw new Error('dsh-feedback-bridge: expected mode ' + expected.toString(8) + ' on ' + filePath + ', found ' + mode.toString(8));
  }
}

/**
 * Quarantine an unreadable or incompatible records file beside the original
 * path so its bytes survive for inspection and fresh records never silently
 * overwrite it.
 *
 * @param filePath - the offending records file path.
 * @returns the quarantine path.
 * @throws {Error} when the rename fails.
 */
async function isolateCorrupt(filePath: string): Promise<string> {
  const quarantine = filePath + '.corrupt-' + Date.now() + '-' + randomBytes(4).toString('hex');
  await rename(filePath, quarantine);
  return quarantine;
}

/**
 * Normalize one parsed records-file value into the record list, or null when
 * it cannot be interpreted. The wrapper must carry the exact schema version
 * and a records array of valid five-field records.
 *
 * @param value - parsed JSON value.
 * @returns the valid records, or null for unknown versions and malformed files.
 */
function normalizeRecords(value: unknown): StoredSubmissionRecord[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== RECORDS_SCHEMA_VERSION) return null;
  const records = candidate.records;
  if (!Array.isArray(records)) return null;
  for (let index = 0; index < records.length; index += 1) {
    try {
      assertRecord(records[index], index);
    } catch (error) {
      // A malformed record is a corrupt file: quarantine in load handles it.
      void error;
      return null;
    }
  }
  return records as StoredSubmissionRecord[];
}

/**
 * Persist one submission record atomically, appending it to any existing
 * records: write a sibling temp file, fsync it, then rename over the target
 * — never delete-then-rename. A corrupt or unknown-version existing file is
 * quarantined first (never silently overwritten) and the fresh list starts
 * with the new record. Records are immutable: this module offers no update
 * or delete path.
 *
 * @param filePath - target records file path.
 * @param input - title, permanent URL, and submission account; id and
 * submittedAt are stamped here.
 * @returns the persisted record.
 */
export async function appendRecord(filePath: string, input: SubmissionRecordInput): Promise<StoredSubmissionRecord> {
  assertRecordInput(input);
  let existing: StoredSubmissionRecord[] = [];
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    const normalized = normalizeRecords(parsed);
    if (normalized === null) {
      await isolateCorrupt(filePath);
    } else {
      existing = normalized;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // First record: no existing file yet.
    } else if (error instanceof SyntaxError) {
      await isolateCorrupt(filePath);
    } else {
      throw error;
    }
  }
  const record: StoredSubmissionRecord = {
    id: randomUUID(),
    title: input.title,
    url: input.url,
    submittedAt: new Date().toISOString(),
    account: input.account,
  };
  const serialized = JSON.stringify({ version: RECORDS_SCHEMA_VERSION, records: [...existing, record] }, null, 2) + '\n';
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!isWindows()) {
    await chmod(dir, 0o700);
    await assertPosixMode(dir, 0o700);
  }
  const tmp = join(dir, '.' + Date.now() + '-' + randomBytes(6).toString('hex') + '.records.tmp');
  const fd = await open(tmp, 'wx', 0o600);
  try {
    await fd.writeFile(serialized, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (!isWindows()) await chmod(tmp, 0o600);
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  if (!isWindows()) {
    await assertPosixMode(filePath, 0o600);
    // fsync the directory so the rename itself survives a crash.
    const dirFd = await open(dir, 'r');
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
  }
  return record;
}

/**
 * Read the persisted submission records, or an empty list when no valid
 * records file exists. Missing files return []; unreadable, malformed, or
 * unknown-version files are quarantined (never silently overwritten) and
 * still resolve to an empty list.
 *
 * @param filePath - target records file path.
 * @returns the stored records.
 */
export async function loadRecords(filePath: string): Promise<StoredSubmissionRecord[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    await isolateCorrupt(filePath);
    return [];
  }
  const normalized = normalizeRecords(parsed);
  if (normalized === null) {
    await isolateCorrupt(filePath);
    return [];
  }
  return normalized;
}
