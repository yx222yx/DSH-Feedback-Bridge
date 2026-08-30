import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';

/** Five editable draft fields a persisted record must carry as strings. */
export interface DraftFields {
  title: string;
  scenario: string;
  gap: string;
  desired: string;
  context: string;
}

/** Material class of one confirmed feedback source. */
export type SourceKind = 'message' | 'tool-result' | 'diagnostic';

/** Speaker or producer role of one confirmed feedback source. */
export type SourceRole = 'user' | 'assistant' | 'steering' | 'context' | 'tool' | 'error' | 'session';

/**
 * One user-confirmed feedback source persisted with the draft. `text` is the
 * reviewed snapshot captured at confirmation time, never live conversation
 * content; `truncated` marks a capture clipped at the per-source cap and
 * `sensitive` is the advisory marker from the capture-time scan.
 */
export interface ConfirmedSourceRecord {
  id: string;
  sessionId: string;
  kind: SourceKind;
  role: SourceRole;
  label: string;
  text: string;
  truncated: boolean;
  sensitive: boolean;
  capturedAt: string;
}

/** A persisted draft record: schema version plus the five fields, sources, and updatedAt. */
export interface StoredDraft extends DraftFields {
  version: typeof DRAFT_SCHEMA_VERSION;
  sources: ConfirmedSourceRecord[];
  updatedAt: string;
}

/**
 * On-disk schema version of the persisted feedback draft. Bump on any
 * incompatible change to the stored record; unknown versions are quarantined
 * by {@link load} rather than interpreted. Version 2 adds the confirmed
 * sources array; version-1 records migrate in memory with empty sources.
 */
export const DRAFT_SCHEMA_VERSION = 2;

/** Maximum confirmed sources one draft may carry. */
export const MAX_SOURCES = 32;

/** Byte cap on one confirmed source's captured text snapshot. */
export const MAX_SOURCE_TEXT = 16 * 1024;

/** Draft fields a persisted record must carry as strings. */
const DRAFT_FIELDS = ['title', 'scenario', 'gap', 'desired', 'context'] as const;

/** The exact key roster a confirmed source record must carry. */
const SOURCE_KEYS = ['id', 'sessionId', 'kind', 'role', 'label', 'text', 'truncated', 'sensitive', 'capturedAt'] as const;

/** Accepted source material classes. */
const SOURCE_KINDS = ['message', 'tool-result', 'diagnostic'] as const;

/** Accepted source producer roles. */
const SOURCE_ROLES = ['user', 'assistant', 'steering', 'context', 'tool', 'error', 'session'] as const;

/**
 * True on native Windows. POSIX permission guarantees (0600/0700) are
 * hard-asserted only here; Windows carries no equivalent ACL claim.
 */
function isWindows(): boolean {
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
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
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
export function draftFilePath(dshHome: string = resolveDshHome()): string {
  return join(dshHome, 'dsh-feedback-bridge', 'draft.json');
}

/**
 * Verify the five draft fields are strings; the durable-file boundary fails
 * loud instead of persisting a malformed record.
 *
 * @param draft - draft fields to persist.
 * @throws {Error} naming the first non-string field.
 */
function assertDraftFields(draft: unknown): asserts draft is DraftFields {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('draft must be an object');
  }
  const candidate = draft as Record<string, unknown>;
  for (const key of DRAFT_FIELDS) {
    if (typeof candidate[key] !== 'string') {
      throw new Error('draft field ' + key + ' must be a string');
    }
  }
}

/**
 * Assert one parsed value is a valid confirmed source record, naming the
 * first invalid aspect. The durable-file and wire boundaries share this so a
 * malformed record never lands on disk and never reaches the store.
 *
 * @param entry - one candidate source record.
 * @param index - position inside the sources array, for the error message.
 * @throws {Error} naming the first invalid field.
 */
function assertSourceRecord(entry: unknown, index: number): asserts entry is ConfirmedSourceRecord {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('source ' + index + ' must be an object');
  }
  const candidate = entry as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== SOURCE_KEYS.length
    || SOURCE_KEYS.some((key) => !(key in candidate))
  ) {
    throw new Error('source ' + index + ' must contain exactly the keys: ' + SOURCE_KEYS.join(', '));
  }
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    throw new Error('source ' + index + ' id must be a non-empty string');
  }
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.trim() === '') {
    throw new Error('source ' + index + ' sessionId must be a non-empty string');
  }
  if (!(SOURCE_KINDS as readonly string[]).includes(candidate.kind as string)) {
    throw new Error('source ' + index + ' kind must be one of: ' + SOURCE_KINDS.join(', '));
  }
  if (!(SOURCE_ROLES as readonly string[]).includes(candidate.role as string)) {
    throw new Error('source ' + index + ' role must be one of: ' + SOURCE_ROLES.join(', '));
  }
  if (typeof candidate.label !== 'string' || candidate.label.trim() === '') {
    throw new Error('source ' + index + ' label must be a non-empty string');
  }
  if (typeof candidate.text !== 'string') {
    throw new Error('source ' + index + ' text must be a string');
  }
  if (Buffer.byteLength(candidate.text, 'utf8') > MAX_SOURCE_TEXT) {
    throw new Error('source ' + index + ' text exceeds the ' + MAX_SOURCE_TEXT + ' byte cap');
  }
  if (typeof candidate.truncated !== 'boolean') {
    throw new Error('source ' + index + ' truncated must be a boolean');
  }
  if (typeof candidate.sensitive !== 'boolean') {
    throw new Error('source ' + index + ' sensitive must be a boolean');
  }
  if (typeof candidate.capturedAt !== 'string' || candidate.capturedAt.trim() === '') {
    throw new Error('source ' + index + ' capturedAt must be a non-empty string');
  }
}

/**
 * Validate a sources value against the record contract and the per-draft and
 * per-source caps. Shared by the wire boundary (route payloads) and the
 * durable-file boundary (save), so a malformed array fails loud exactly once
 * with a stable message.
 *
 * @param sources - parsed sources value.
 * @returns the validated records.
 * @throws {Error} naming the first invalid aspect.
 */
export function validateSources(sources: unknown): ConfirmedSourceRecord[] {
  if (!Array.isArray(sources)) throw new Error('sources must be an array');
  if (sources.length > MAX_SOURCES) {
    throw new Error('sources must contain at most ' + MAX_SOURCES + ' records');
  }
  for (let index = 0; index < sources.length; index += 1) {
    assertSourceRecord(sources[index], index);
  }
  return sources as ConfirmedSourceRecord[];
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
 * Quarantine an unreadable or incompatible draft file beside the original
 * path so its bytes survive for inspection and a fresh draft never silently
 * overwrites it.
 *
 * @param filePath - the offending draft file path.
 * @returns the quarantine path.
 * @throws {Error} when the rename fails.
 */
async function isolateCorrupt(filePath: string): Promise<string> {
  const quarantine = filePath + '.corrupt-' + Date.now() + '-' + randomBytes(4).toString('hex');
  await rename(filePath, quarantine);
  return quarantine;
}

/**
 * Normalize one parsed record to the current schema, or null when it cannot
 * be interpreted. Version-1 records (five string fields plus updatedAt)
 * migrate in memory to version 2 with empty sources; version-2 records must
 * pass the full sources validation.
 *
 * @param record - parsed JSON value.
 * @returns the normalized stored draft, or null for unknown versions and
 * malformed records.
 */
function normalizeRecord(record: unknown): StoredDraft | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const candidate = record as Record<string, unknown>;
  if (typeof candidate.updatedAt !== 'string') return null;
  for (const key of DRAFT_FIELDS) {
    if (typeof candidate[key] !== 'string') return null;
  }
  const fields: DraftFields = {
    title: candidate.title,
    scenario: candidate.scenario,
    gap: candidate.gap,
    desired: candidate.desired,
    context: candidate.context,
  } as DraftFields;
  if (candidate.version === 1) {
    return { version: DRAFT_SCHEMA_VERSION, ...fields, sources: [], updatedAt: candidate.updatedAt };
  }
  if (candidate.version !== DRAFT_SCHEMA_VERSION) return null;
  try {
    const sources = validateSources(candidate.sources);
    return { version: DRAFT_SCHEMA_VERSION, ...fields, sources, updatedAt: candidate.updatedAt };
  } catch {
    return null;
  }
}

/**
 * Persist a draft record atomically: write a sibling temp file, fsync it,
 * then rename over the target — never delete-then-rename. Node's rename
 * replaces an existing file on POSIX and on Windows (MoveFileEx with
 * REPLACE_EXISTING). The store stamps the schema version and updatedAt; the
 * caller supplies the five string fields and the confirmed sources.
 *
 * @param filePath - target draft file path.
 * @param draft - five string draft fields.
 * @param sources - confirmed feedback sources; defaults to none.
 * @returns the persisted record.
 */
export async function save(
  filePath: string,
  draft: DraftFields,
  sources: readonly ConfirmedSourceRecord[] = [],
): Promise<StoredDraft> {
  assertDraftFields(draft);
  const validated = validateSources(sources);
  const record: StoredDraft = {
    version: DRAFT_SCHEMA_VERSION,
    ...draft,
    sources: validated,
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(record, null, 2) + '\n';
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!isWindows()) {
    await chmod(dir, 0o700);
    await assertPosixMode(dir, 0o700);
  }
  const tmp = join(dir, '.' + Date.now() + '-' + randomBytes(6).toString('hex') + '.draft.tmp');
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
 * Version-1 records migrate in memory to version 2 with empty sources; the
 * file itself is rewritten only by the next save.
 *
 * @param filePath - target draft file path.
 * @returns the stored record or null.
 */
export async function load(filePath: string): Promise<StoredDraft | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    await isolateCorrupt(filePath);
    return null;
  }
  const normalized = normalizeRecord(record);
  if (normalized === null) {
    await isolateCorrupt(filePath);
    return null;
  }
  return normalized;
}

/**
 * Delete the persisted draft. Removing a file that does not exist is a
 * no-op, so a discard is idempotent.
 *
 * @param filePath - target draft file path.
 * @returns void.
 */
export async function remove(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
