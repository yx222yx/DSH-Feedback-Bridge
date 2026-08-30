import type { ConfirmedSourceRecord } from './sources.js';
import type { DraftLanguage, DraftPersistence, FeedbackDraft, FeedbackType, FetchLike, FetchResponseLike, PersistedFeedbackDraft } from './types.js';

/** The five editable fields a save payload carries; the Host stamps version and updatedAt. */
const DRAFT_FIELDS = ['title', 'scenario', 'gap', 'desired', 'context'] as const;

/**
 * Serialized draft transport: the only client path that reads or writes
 * the Host draft route. All writes run through one promise queue so Host
 * and Client mutations happen in submission order, and a generation
 * token makes a save scheduled before a discard a no-op once the discard
 * has been confirmed — a late autosave can never resurrect a discarded
 * draft. The payload carries exactly the five editable fields plus the
 * confirmed sources (the key is omitted when none exist); version and
 * updatedAt are stamped by the Host. Confirmed sources travel only as the
 * user-reviewed snapshots the workspace captured; live conversation content
 * never leaves the browser through this route.
 *
 * @param draftUrl - same-origin Host draft route.
 * @param fetchImpl - fetch-like function; defaults to the global fetch.
 * @returns the persistence handle.
 */
export function createDraftPersistence({
  draftUrl,
  fetchImpl = (typeof fetch === 'function' ? fetch : undefined) as unknown as FetchLike,
}: {
  draftUrl: string;
  fetchImpl?: FetchLike;
}): DraftPersistence {
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;

  function enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = queue.then(task) as Promise<T>;
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function pickDraft(draft: FeedbackDraft): Record<string, string> {
    const picked: Record<string, string> = {};
    for (const key of DRAFT_FIELDS) picked[key] = draft[key];
    return picked;
  }

  function payload(draft: FeedbackDraft, sources: readonly ConfirmedSourceRecord[]): Record<string, unknown> {
    const body: Record<string, unknown> = pickDraft(draft);
    body.type = draft.type;
    if (draft.language !== undefined) body.language = draft.language;
    if (sources.length > 0) body.sources = [...sources];
    return body;
  }

  function check(response: FetchResponseLike): true {
    if (!response.ok) throw new Error('draft write failed: HTTP ' + response.status);
    return true;
  }

  return {
    generation() {
      return generation;
    },
    load() {
      return enqueue(() => fetchImpl(draftUrl, { method: 'GET' })
        .then((response) => {
          if (!response.ok) throw new Error('draft load failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => {
          const record = (data as { draft?: { [key: string]: unknown } | null }).draft ?? null;
          if (record === null) return null;
          const fields = { title: '', scenario: '', gap: '', desired: '', context: '' } as FeedbackDraft;
          for (const key of DRAFT_FIELDS) {
            if (typeof record[key] === 'string') fields[key] = record[key];
          }
          const rawSources = record.sources;
          const sources = Array.isArray(rawSources) ? (rawSources as ConfirmedSourceRecord[]) : [];
          const type: FeedbackType = record.type === 'plugin-request' || record.type === 'harness-feature'
            || record.type === 'harness-defect' || record.type === 'custom'
            ? record.type
            : 'custom';
          const language: DraftLanguage | undefined = record.language === 'zh' || record.language === 'en'
            ? record.language
            : undefined;
          const loaded: PersistedFeedbackDraft = { fields, sources, type };
          if (language !== undefined) loaded.language = language;
          return loaded;
        }));
    },
    save(draft: FeedbackDraft, sources: readonly ConfirmedSourceRecord[]) {
      const token = generation;
      return enqueue(() => {
        if (token !== generation) return false;
        return fetchImpl(draftUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'save', draft: payload(draft, sources) }),
        }).then(check);
      });
    },
    remove() {
      generation += 1;
      return enqueue(() => fetchImpl(draftUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove' }),
      }).then(check));
    },
    keepalive(draft: FeedbackDraft | null, sources: readonly ConfirmedSourceRecord[]) {
      if (draft === null) return;
      const token = generation;
      if (token !== generation) return;
      fetchImpl(draftUrl, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', draft: payload(draft, sources) }),
      }).catch(() => {});
    },
  };
}
