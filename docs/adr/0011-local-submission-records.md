# Persist immutable local submission records for confirmed successes

Issue #11 adds a durable, local-only reference for confirmed successful
submissions so the user can reopen the permanent Discussion link from the
GUI, without implying that the plugin tracks remote replies or state.

## Context

- The Issue #8 submission slice deliberately kept the prepared-nonce store
  in memory ("no durable submission records in this ticket"); after a reload
  the created link existed only in the confirmation panel.
- A stored record must never become a follow-up tracker: v0.1 explicitly
  does not monitor replies, edits, resolution, or other remote status.
- Credentials (OAuth tokens, GitHub CLI tokens) and raw feedback sources are
  sensitive; a stored record must carry only public reference metadata.

## Decision

- **One immutable record per confirmed success.** A new face-neutral module
  `src/host/records.ts` persists records at
  `<DSH_HOME>/dsh-feedback-bridge/records.json` with the wrapper
  `{version: 1, records: [...]}`. A record carries exactly the five fields
  `id` (local UUID), `title` (public title), `url` (permanent
  Discussion URL), `submittedAt` (ISO timestamp), and `account`
  (submission identity login). The durable-file boundary enforces this exact
  key roster, so a record with extra keys (tokens, sources, diagnostics)
  never loads and is quarantined beside the file, mirroring the draft
  store's durability contract (atomic sibling-temp write, fsync, rename,
  0600/0700 POSIX modes).
- **Only a `created` outcome creates a record.** The submission confirm
  handler appends a record exclusively when `createDiscussion` returns
  `{status: 'created'}`. Failed classes, unknown results,
  category-unavailable, and replayed nonces (409) never append. A failed
  local record write after an external create is swallowed with a named
  reason: turning the response into a failure would invite a duplicate
  submission, and the created link stays available in the panel.
- **Read-only route.** `GET /dsh-feedback-bridge/records` lists the
  records; no edit, delete, sync, or polling surface exists. The GUI shows
  the records in a dedicated panel (public title as a link, account, and
  submission time) separate from the recoverable draft, and states that v0.1
  does not track replies, edits, resolution, or other remote status.
- **Storage is separate from the draft.** `records.json` is a sibling of
  `draft.json`; draft writes never touch records and record appends never
  touch the draft, verified at the store, route, and browser levels.

## Consequences

- New Host module `src/host/records.ts`; the submission confirm route
  appends on success; a new `/dsh-feedback-bridge/records` route.
- New Client transport `src/client/records.ts`, the records panel
  `src/client/components/RecordsPanel.tsx`, and locale-owned
  `records.*` dictionary keys in every shipped locale.
- Tests cover creation (confirmed success only), separation from drafts,
  reload/restart durability, opening the stored URL, and the no-credentials/
  no-source content contract at store, route, client, and Web-profile
  acceptance levels (against the local fake GitHub server only).
