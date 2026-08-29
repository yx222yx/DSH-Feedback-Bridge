import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';

/**
 * On-disk schema version of the persisted feedback draft. Bump on any
 * incompatible change to the stored record; unknown versions are quarantined
 * by {@link load} rather than interpreted.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/** Draft fields a persisted record must carry as strings. */
const DRAFT_FIELDS = ['title', 'scenario', 'gap', 'desired', 'context'];

/**
 * True on native Windows. POSIX permission guarantees (0600/0700) are
 * hard-asserted only here; Windows carries no equivalent ACL claim.
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * Resolve the DeepSeek Harness home exactly the way the harness itself does:
 * a non-empty `$DSH_HOME` wins, otherwise `~/.dsh`. A blank override is
 * treated as unset so a misconfigured environment never resolves the home to
 * the working directory.
 *
 * @param env - environment mapping; defaults to process.env.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const expanded = fromEnv.startsWith('~/') || fromEnv.startsWith('~\\')
      ? join(homedir(), fromEnv.slice(2))
      : fromEnv;
    return expanded === '~' ? homedir() : expanded;
  }
  return join(homedir(), '.dsh');
}

/**
 * Absolute path of the single persisted feedback draft under the harness
 * home: `<DSH_HOME>/dsh-feedback-bridge/draft.json`.
 *
 * @param dshHome - harness home; defaults to resolveDshHome().
 * @returns the draft file path.
 */
export function draftFilePath(dshHome = resolveDshHome()) {
  return join(dshHome, 'dsh-feedback-bridge', 'draft.json');
}

/**
 * Verify a stored record matches schema version 1: a plain object carrying
 * exactly the five string fields plus a string updatedAt.
 *
 * @param record - parsed JSON value.
 * @returns true when the record is a valid version-1 draft.
 */
function isStoredDraft(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.version !== DRAFT_SCHEMA_VERSION) return false;
  if (typeof record.updatedAt !== 'string') return false;
  for (const key of DRAFT_FIELDS) {
    if (typeof record[key] !== 'string') return false;
  }
  return true;
}

/**
 * Verify the five draft fields are strings; the durable-file boundary fails
 * loud instead of persisting a malformed record.
 *
 * @param draft - draft fields to persist.
 * @throws {Error} naming the first non-string field.
 */
function assertDraftFields(draft) {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('draft must be an object');
  }
  for (const key of DRAFT_FIELDS) {
    if (typeof draft[key] !== 'string') {
      throw new Error(`draft field ${key} must be a string`);
    }
  }
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
async function assertPosixMode(filePath, expected) {
  if (isWindows()) return;
  const mode = (await stat(filePath)).mode & 0o777;
  if (mode !== expected) {
    throw new Error(`dsh-feedback-bridge: expected mode ${expected.toString(8)} on ${filePath}, found ${mode.toString(8)}`);
  }
}

/**
 * Quarantine an unreadable or incompatible draft file beside the original
 * path so its bytes survive for inspection and a fresh draft never silently
 * overwrites it.
 *
 * @param filePath - the offending draft file path.
 * @returns the quarantine path.
 * @throws {Error} when the rename fails.
 */
async function isolateCorrupt(filePath) {
  const quarantine = `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`;
  await rename(filePath, quarantine);
  return quarantine;
}

/**
 * Persist a draft record atomically: write a sibling temp file, fsync it,
 * then rename over the target — never delete-then-rename. Node's rename
 * replaces an existing file on POSIX and on Windows (MoveFileEx with
 * REPLACE_EXISTING). The store stamps the schema version and updatedAt; the
 * caller supplies the five string fields.
 *
 * @param filePath - target draft file path.
 * @param draft - five string draft fields.
 * @returns the persisted record.
 */
export async function save(filePath, draft) {
  assertDraftFields(draft);
  const record = { version: DRAFT_SCHEMA_VERSION, ...draft, updatedAt: new Date().toISOString() };
  const serialized = JSON.stringify(record, null, 2) + '\n';
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!isWindows()) {
    await chmod(dir, 0o700);
    await assertPosixMode(dir, 0o700);
  }
  const tmp = join(dir, `.${Date.now()}-${randomBytes(6).toString('hex')}.draft.tmp`);
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
 * Read the persisted draft, or null when no valid draft exists. Missing files
 * return null; unreadable, malformed, or unknown-version records are
 * quarantined (never silently overwritten) and still resolve to null.
 *
 * @param filePath - target draft file path.
 * @returns the stored record or null.
 */
export async function load(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    await isolateCorrupt(filePath);
    return null;
  }
  if (!isStoredDraft(record)) {
    await isolateCorrupt(filePath);
    return null;
  }
  return record;
}

/**
 * Delete the persisted draft. Removing a file that does not exist is a
 * no-op, so a discard is idempotent.
 *
 * @param filePath - target draft file path.
 * @returns void.
 */
export async function remove(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
