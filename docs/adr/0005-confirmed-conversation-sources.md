# Confirm conversation sources before they feed draft preparation

Issue #5 lets a user choose messages and diagnostic context from the current DSH
conversation as feedback sources. The plugin may recommend useful sources, but
only explicit user confirmation makes a source available to the feedback
workflow, and selected evidence stays separate from the public draft.

## Context

- v0.1 targets the DSH `web` profile. The workspace UI already edits a
  custom-feedback draft and persists it at
  `<DSH_HOME>/dsh-feedback-bridge/draft.json` (ADR 0003, schema v1: five string
  fields plus `updatedAt`, atomic writes, 0600/0700 modes, quarantine of
  corrupt or unknown versions).
- The DSH client runtime exposes the current conversation to feature packages:
  `ctx.sessions.list` carries the current session id, and
  `ctx.sessions.binding(id).session` is an `ObservableSnapshot<ConversationSnapshot>`
  (`@deepseek-ai/dsh-client-runtime@0.1.1-rc.2`, the declared compatibility
  floor). The snapshot's `nodes` cover user/assistant/steering/context
  messages, tool results, turn errors, and token-cap notices; `openState`
  gates the loaded window.
- Product boundaries from Issue #1 and #5: no default selection of the whole
  conversation; recommendation is not selection; only user-confirmed sources
  feed later draft preparation; removing a source ends its contribution; raw
  sources stay separate from the public draft; unselected and sensitive
  material must never appear in the exported Markdown; no model-assisted draft
  generation (#6), no similarity checks (#7), no GitHub authorization or
  writes; zero non-necessary external requests.

## Decision

- **Read the conversation through the official client face.** The workspace
  wraps `ctx.sessions` in a small observable source
  (`src/client/conversation.ts`): `list.current` selects the session,
  `binding(current).session.getSnapshot()` yields the snapshot, and the list
  subscription covers selection changes and the transient window before a
  binding resolves. No host-side conversation read is needed; the Host never
  receives live conversation content.
- **Candidates are derived, never persisted.** `deriveSourceCandidates` maps
  in-window nodes to candidate rows (visible text blocks only; reasoning,
  images, and tool-call arguments are excluded) plus one session-diagnostics
  block, newest first, capped at 50. Outside an open window, or with no message
  material, there are no candidates. The diagnostics labels and the fixed
  error sentences are locale-owned `SourceCopy` supplied by the workspace's
  dictionaries; the pure module hardcodes no user-facing copy.
- **Recommendations are deterministic rules, and are proposals only.**
  `applyRecommendations` flags the session-diagnostics block, the latest
  user/steering message, content matching a small defect-keyword set, and
  error-signal tool results or turn errors. A recommendation badge is visually
  distinct from confirmation and never enters storage. Rule-based
  recommendations keep the flow testable and free of model calls (model-driven
  recommendation would need a host LLM consumer and is out of scope here).
- **Only confirmed sources persist, as reviewed snapshots.** Confirming a
  candidate captures its text at that moment (truncated to 16 KiB with a
  `truncated` flag) plus id, session id, kind, role, a locale-owned label, the
  advisory sensitive flag, and the confirmation timestamp. Persisted records
  live in `draft.json` schema v2 under `sources` (max 32), validated at both
  the route and the durable-file boundary; a malformed record fails loud and is
  never written. Version-1 files migrate in memory to v2 with empty sources and
  are rewritten on the next save; unknown versions keep the ADR 0003
  quarantine.
- **Public content is assembled only from reviewed fields.** `buildDraftMarkdown`
  remains the sole Markdown serializer and consumes only the five public
  fields. A confirmed source contributes to the draft only through the
  explicit "quote into field" action, which copies the reviewed snapshot text
  into a public field the user then edits and reviews in the card. Removing a
  source deletes it from `sources` and immediately ends its availability;
  already-quoted text is user content and stays in the field.
- **Sensitive material is flagged, never auto-handled.** A small documented
  marker set (API-key shapes, password/secret/token words, private-key headers,
  AWS access-key shape) shows an advisory badge on a candidate or confirmed
  record. Markers never select, block, or rewrite content; user confirmation
  remains the only gate, per the parent spec's privacy stance.
- **Zero new network or writes.** The workspace reads conversation data from
  the browser's own client state and the same-origin status route (for the
  diagnostics block's DSH version); persistence stays on the existing draft
  route. No GitHub API calls and no external requests are added.

## Consequences

- Draft `draft.json` schema moves from v1 to v2; existing v1 drafts survive
  through the in-memory migration.
- The confirmed-source record contract is mirrored on both compiler faces
  (Host `draft-store.ts`, Client `sources.ts`) and enforced by tests on each
  side; the Host validation is authoritative.
- Candidates reflect the loaded window only; older-message pagination
  (`loadOlder`) is out of scope for this slice.
- Recommendations are language-dependent (keyword set covers zh/en) and
  intentionally simple; they are a UX affordance, not a classification.
