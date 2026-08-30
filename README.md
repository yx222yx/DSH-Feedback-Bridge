# DSH-Feedback-Bridge

一个 DeepSeek Harness 插件，帮助用户将功能想法和错误反馈整理为清晰、注重隐私的 GitHub Discussions。
A DeepSeek Harness plugin that helps users turn feature ideas and bug reports into clear, privacy-aware GitHub Discussions.

## v0.1 slice (Issue #2, #3, and #4)

The current slice ships the installable `dsh.bundle` for the DSH `web` profile:

- Host plugin `dsh-feedback-bridge` loads once `webServer` is available and exposes
  `GET /dsh-feedback-bridge/status` plus `GET|POST /dsh-feedback-bridge/draft`
  (the draft route limits the JSON body size and rejects unexpected methods and
  actions).
- Client plugin registers a “DSH Feedback Bridge” status section in the Web GUI
  settings surface (plugin status only) and reads the Host status through that
  route.
- A dedicated **社区反馈** left-navigation entry in the Web GUI sidebar opens the
  community-feedback workspace: a custom-feedback draft with title, scenario,
  your problem or situation, desired result, and additional context; an exact
  Markdown review card; copy-to-clipboard and .md export; and manual submission
  guidance linking to the official DeepSeek Harness Discussions.
- The in-progress draft is persisted on the Host at
  `<DSH_HOME>/dsh-feedback-bridge/draft.json` (schema `{version, title, scenario,
  gap, desired, context, sources, updatedAt}`): edits autosave, a page reload or
  DSH restart resumes the draft, closing flushes any pending save, and 取消 asks
  for an explicit confirmation before discarding. Export always keeps the draft
  (“已导出，草稿仍保留”). Corrupt or unknown-version files are quarantined instead
  of silently overwritten; a confirmed discard can never be undone by a late
  autosave. Copy, export, autosave, and discard make zero GitHub writes and zero
  external network requests.
- The workspace lists candidate **反馈来源** from the current conversation
  (messages, tool results, turn errors, and a session-diagnostics block) through
  the official `ctx.sessions` client face. Rule-based recommendations are
  visibly badges and never select anything; only explicit user confirmation moves
  a candidate into the persisted `sources` array (reviewed snapshot captured at
  confirm time, capped at 16 KiB per source, 32 sources max). Removing a source
  immediately stops it feeding draft preparation. The exported Markdown is built
  only from the five reviewed public fields — raw messages, logs, and diagnostics
  never enter it unexamined; advisory-only sensitive markers warn without
  auto-blocking.
- **Model-assisted drafting (Issue #6)** uses the model currently selected in
  the conversation (`ctx.sessions` request-header config) through the official
  Host `ctx.llm` seam — no plugin model selector, no plugin API key. The
  workspace can generate suggestions (recommended feedback type + reason,
  non-blocking missing-information notes scoped per feedback type, an editable
  Chinese/English draft, advisory privacy findings) from the confirmed sources
  only; the model output is staged and every application is an explicit
  per-field action guarded by a field-version snapshot taken at request start,
  so a suggestion never silently overwrites content the user established
  during or before the request. Structured output is validated at runtime with
  a repair panel for invalid/truncated responses (re-validation runs locally),
  and provider failures surface distinct localized states with retry. Draft
  schema v3 adds the authoritative feedback `type` (plugin request / Harness
  feature suggestion / Harness defect report / custom) and the optional
  submission `language` (English is the default only when unset). Privacy
  findings are advisory and read-only: secrets, personal information, private
  paths, confidential content, and excessive context are flagged but never
  rewritten, redacted, or auto-published.
- The declared DSH compatibility range is `>=0.1.1-rc.2 <0.2.0`; an incompatible
  version fails with a clear message.

### Persistence known limitations

- Only the DSH `web` profile is supported in v0.1. DSH exposes no reliable
  profile-identity interface, so other profiles sharing the same `DSH_HOME` may
  observe the same draft file.
- Only one in-progress draft exists at a time; there is no draft history and no
  submitted-record separation yet.

## Install

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.0.tgz
dsh --profile web --no-open --port 3080
```

Open the Web GUI, select **社区反馈** in the left navigation to start or resume a
custom-feedback draft, and use 复制草稿 / 导出草稿 to keep a copy with the manual
submission instructions. `http://127.0.0.1:3080/dsh-feedback-bridge/status`
shows the Host status payload.

## Test

```sh
pnpm install
pnpm typecheck   # strict check of the Host and Client source trees
pnpm test        # builds lib/ from src/, then runs the full suite
```

`src/` is the single authoritative TypeScript implementation; `pnpm test`
regenerates `lib/` (Host via tsc, Client bundle via esbuild) before running,
so the suite always exercises the generated runtime artifacts. The acceptance
tests pack the bundle, install it into a clean `DSH_HOME` Web
profile, and boot DSH without a DeepSeek API key or GitHub account. They drive
real headless-browser click-throughs of the left-navigation to export path
(including Issue #6's model-assist flow: a test-only fake bundle intercepts the
official `llm/stream` waterfall for hand-built calls to exercise structured
success, malformed output, and provider failure deterministically, while one
real credentialless path asserts graceful model-failed degradation) and assert
zero GitHub and zero external network requests. The browser acceptance test
requires Playwright's Chromium; install it once with
`pnpm exec playwright-core install chromium`.