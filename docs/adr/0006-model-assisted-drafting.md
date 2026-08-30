# Call the current session model through the Host llm seam for assisted drafting

Issue #6 adds model-assisted bilingual drafting and privacy review: the plugin
uses the model the user currently has selected in DSH to recommend a feedback
type, point out non-mandatory missing information, draft editable Chinese or
English content, and flag advisory privacy findings. The model output is a
proposal; the user keeps final authority.

## Context

- v0.1 targets the DSH `web` profile. Issue #5 established user-confirmed
  conversation sources (ADR 0005) persisted with the draft at
  `<DSH_HOME>/dsh-feedback-bridge/draft.json` (ADR 0003, schema v2 at the
  time). The Host owns the draft route and never receives live conversation
  content.
- The DSH Host exposes two official seams this slice relies on, both verified
  in the installed `@deepseek-ai/*@0.1.1-rc.2` type declarations:
  - `ctx.llm.stream(options: GenerateOptions)` (dsh-llm `LlmRuntime`) is the
    plugin model-call API, interceptable via the `llm/stream` waterfall. At
    this DSH version `GenerateOptions` has no structured-output field
    (sampling is temperature/maxTokens/stop only), so structured output is
    prompt-requested JSON plus strict runtime validation with a repair
    fallback, per Issue #1's adapter-boundary decision.
  - `ctx.sessions.get(id).requestHeader()?.config` (dsh-session
    `SessionStore`/EpochHeader) is the exact `LlmCallConfig` the loop uses
    for the session's next request: the authoritative "current user-selected
    model". Its fields map 1:1 onto `GenerateOptions`.
- DSH rules that apply: model-visible input must be reconstructable from the
  session log ("Model-visible ⟺ logged"; a new model-visible input requires a
  session event); registrations are effects; no hardcoded deployment tunables;
  validate at wire and durable boundaries; keep browser code free of
  Node-only modules.

## Decision

- **Model calls live on the Host**, via `ctx.llm.stream`. The Client posts a
  validated assist request (sessionId, language, currentType, confirmed
  sources) to a new same-origin route `/dsh-feedback-bridge/assist`; the Host
  resolves the current session's `EpochHeader.config`, builds one
  plugin-marked user message from the confirmed source snapshots only, streams
  the call, validates the structured output, and returns a discriminated
  outcome (ok / repair-needed / model-failed / no-model-context). The browser
  never holds credentials, and the Host still never receives live conversation
  content (only reviewed snapshots it already persists).
- **The session's model config is inherited, never replaced.** No plugin model
  selector, no plugin API key, no fallback model. A session without a
  request header yields `no-model-context` and the UI explains that the
  conversation must produce a model reply first.
- **Structured output is prompt-requested JSON with a four-level adaptation
  pipeline** (clean JSON; fenced/prose-wrapped JSON via balanced-object
  recovery; invalid/truncated output surfaced as repair-needed with the raw
  text preserved; terminal provider failures surfaced as model-failed with the
  provider code). A shared face-neutral parse/validate module
  (`src/host/assist-schema.ts`, bundled into the Client as well) is the single
  authority, so repair re-validation runs the same rules locally without a
  second model call.
- **Model output is advisory only.** It is staged in the UI; applying a
  suggested field is an explicit per-field action, guarded by a field-version
  snapshot taken at request start so a suggestion never silently overwrites
  content the user established during or after the request, or pre-existing
  content that differs from the suggestion. The authoritative feedback type and language live on the draft record
  (schema v3) and are only ever changed by the user.
- **Model-visible input is logged.** Before responding, the Host appends a
  log-only `dsh-feedback-bridge/assist` session event (merged into
  `SessionEventMap`) carrying the full model-visible envelope (instruction
  text, confirmed source text, language, current type, provider/model) plus
  the outcome. Raw model responses are not persisted long-term; only the
  user-acknowledged parts (type, language, applied field text) become durable
  draft state.
- **Privacy review is advisory and read-only.** A deterministic client scan
  (`src/client/privacy.ts`) flags credential markers, private paths, and
  excessive context over the confirmed sources and the public fields, with
  severities; the model's own privacy findings are shown alongside. No code
  path rewrites, redacts, or deletes content because of a finding.
- **Draft schema v3** adds `type` (four feedback types, default custom) and
  optional `language` (absence means the English default) to the stored
  record; v1/v2 records migrate in memory; unknown versions keep the ADR 0003
  quarantine.
- **Testing keeps the model controllable.** Unit tests inject a fake stream
  into `runAssist`; browser acceptance installs a test-only bundle that
  intercepts the `llm/stream` waterfall for non-agent-loop calls
  (`isAgentLoopRequest`) and answers from fixture files, while loop requests
  pass through to the real credentialless path. At least one real
  Web-profile path (no credentials) asserts graceful model-failed degradation
  with user content preserved.

## Consequences

- The plugin's Host `inject` grows to `['webServer', 'sessions', 'llm']`;
  the web profile provides all three from dsh-base.
- `@deepseek-ai/dsh-session` joins the devDependencies for types and the
  `SessionEventMap` extension; `@deepseek-ai/dsh-llm` was already present.
- New lib files ship with the bundle; the pack-content whitelist tracks them.
- The `dsh-feedback-bridge/assist` session event is informational and does
  not enter the conversation surface; readers that do not know it skip it.
- Repaired raw responses live only in memory; a reload discards them (the
  user's draft fields remain autosaved).
- The four feedback types share the existing five-field public model;
  type-specific needs surface as non-blocking missing-information suggestions,
  not dynamic field sets.
