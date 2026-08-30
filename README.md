# DSH-Feedback-Bridge

一个 DeepSeek Harness 插件，帮助用户将功能想法和错误反馈整理为清晰、注重隐私的 GitHub Discussions。
A DeepSeek Harness plugin that helps users turn feature ideas and bug reports into clear, privacy-aware GitHub Discussions.

## What it does

The **社区反馈** (community feedback) entry in the DSH Web GUI left navigation opens a workspace that turns a conversation into a reviewable community submission for the official DeepSeek Harness GitHub Discussions:

- **Draft** — a feedback draft with title, scenario, the problem or situation you encountered, desired result, and additional context, plus an exact Markdown review card.
- **Sources** — candidate 反馈来源 (messages, tool results, turn errors, session diagnostics) from the current conversation; only explicitly confirmed sources feed draft preparation.
- **Model-assisted drafting** — optional suggestions (feedback type + reason, missing-information notes, an editable Chinese/English draft, advisory privacy findings) using the model currently selected in your conversation.
- **Similarity check** — a read-only, advisory search for related official Discussions, plugins, and documentation once the minimum feedback intent exists.
- **Submit or export** — with GitHub authorization, submit to the official `deepseek-ai/deepseek-harness` Discussions after a distinct final confirmation; without authorization, export the exact Markdown draft with manual submission guidance.

## Supported versions

- **DeepSeek Harness**: `>=0.1.1-rc.2 <0.2.0`. The plugin declares this range in its `dsh.compatibility.dsh` metadata and enforces it at boot: an incompatible or undetectable DSH version fails with a clear message before the web server opens.
- **Profile**: the DSH `web` profile only.
- **Environments**: WSL2 Ubuntu is the primary installation and acceptance environment. Native Windows receives focused compatibility validation (paths, GitHub CLI spawn, Device Flow/browser handoff, credential boundaries) without different product behavior.

## Install

### WSL2 Ubuntu (primary)

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.0.tgz
dsh --profile web --no-open --port 3080
```

Open the Web GUI, select **社区反馈** in the left navigation to start or resume a draft, and use 复制草稿 / 导出草稿 to keep a copy with the manual submission instructions. `http://127.0.0.1:3080/dsh-feedback-bridge/status` shows the Host status payload.

### Native Windows

The same two commands work on native Windows. Notes:

- The in-progress draft and the submission records live under `<DSH_HOME>\dsh-feedback-bridge\`. On WSL2/Linux they are written with POSIX permissions `0600`/`0700`; on Windows the plugin relies on Node's rename-replacement semantics and makes no ACL-equivalence claim.
- The GitHub CLI path spawns `gh` with `windowsHide` and never through a shell, and never inherits ambient `GH_TOKEN`/`GITHUB_TOKEN`/model credential environment variables.
- Browser-assisted GitHub sign-in (Device Flow) hands off to GitHub's official device page in your default browser, exactly as on WSL2.

## Using the workspace

- Select **社区反馈** in the left navigation. The workspace opens with a custom-feedback draft; a previously saved draft is restored automatically.
- Confirm conversation 反馈来源 you want to include; only confirmed sources are persisted and can feed draft preparation.
- Fill the five public fields. The review card always shows the exact Markdown that will be copied, exported, or submitted.
- Optional: run **model-assisted drafting** (uses the model currently selected in your conversation) and the early **similarity check** (advisory links; never blocks the workflow).
- Use 复制草稿 to copy the exact Markdown to the clipboard or 导出草稿 to download `dsh-community-feedback-draft.md`. Export always keeps the draft (“已导出，草稿仍保留”).

## Authorizing GitHub submission

The shipped bundle enables **both** authorization paths by default (`github.auth.provider: both` with the official maintainer-registered OAuth App's public client ID). A deployment that wants draft export only sets `github.auth.provider: none` in its own profile patch; any key below can be overridden there (`<DSH_HOME>/profiles/web/cordis.patch.yml`):

### GitHub Device Flow (recommended novice path)

The final confirmation offers **Sign in with GitHub** using the bundled `github.oauth.clientId` (a deployment may override it with its own GitHub OAuth App's public client ID; no client secret, no callback route, no project backend). The Host requests a device code, shows GitHub's verification URI and a short user code in the dialog (with a copy action), and polls GitHub's token endpoint at its interval (pending, slow-down, expiry, denial, insufficient `public_repo` scope, and failures are handled distinctly). The grant is stored through the DSH credentials service under `credentialKey('dsh-feedback-bridge', 'github-oauth')`.

**Token lifetime and renewal.** GitHub access tokens are short-lived (OAuth app tokens typically expire after about 8 hours). When GitHub issues a refresh token alongside the access token, the plugin stores it with the grant and **renews the access token automatically** before the next submission (including renewing after a server-side rejection), so you normally do not need to sign in again. Refresh tokens themselves expire (GitHub issues them for roughly six months) and can be revoked; when the grant can no longer be renewed, the plugin clears it and returns the final confirmation to the **sign in again** step with a clear “your GitHub authorization is missing or expired” message — it never surfaces as an unexplained submission failure, and the draft export always remains available. If GitHub issues no refresh token, an expired access token likewise returns to the sign-in step instead of failing silently.

### GitHub CLI (advanced path)

`provider: gh` — for users who already use the GitHub CLI. The plugin discovers the stored accounts from `gh auth status` (it never reads `git config`, repository metadata, or GitLab identity), forces an explicit account choice whenever several exist, and resolves the chosen account's token with `gh auth token -u <login>`. The token exists only in Host memory for one request; the plugin never runs `gh auth switch`, so your terminal-wide active account stays untouched. Missing or expired GitHub CLI authorization surfaces `gh auth login` guidance plus the draft-export fallback.

### Both (shipped default)

`provider: both` is the shipped default: the final confirmation asks you to choose between **Sign in with GitHub** and **Use GitHub CLI account** (the latter shown only when a local `gh` login exists), with an explicit selection on each side. An existing Device Flow grant is reused automatically.

Every provider shows the authorized public login again on the final confirmation before submission.

## Submission outcomes

After the distinct final confirmation (a one-shot nonce makes a second confirm impossible):

- **Created** — the plugin shows the permanent Discussion link and stores a local submission record (title, link, submitting account, time) in the GUI; the records panel reopens the link any time.
- **Unknown result** — the creation request was sent but the outcome could not be determined. The plugin never retries automatically, shows manual verification guidance (“check the official Discussions”), and keeps the draft exportable.
- **Denied / expired / insufficient scope / failure** — distinct localized states with retry or cancel; denial and cancellation never create anything, and the draft export remains available.

The mutation targets only the official `deepseek-ai/deepseek-harness` Discussions — never issues, never another repository, and only ever exactly one `createDiscussion` per confirmed submission.

## Disconnect

An authorized Device Flow session offers a **disconnect** action that revokes the stored OAuth grant. After disconnecting, the plugin returns to the sign-in step and draft export remains available. (The GitHub CLI path never changes your terminal-wide `gh` active account.)

## Privacy limitations

- **Local files** — the in-progress draft is persisted at `<DSH_HOME>/dsh-feedback-bridge/draft.json` and submission records at `<DSH_HOME>/dsh-feedback-bridge/records.json`. Draft content never enters logs or the status payload. On POSIX, files and directories are created with `0600`/`0700`; on Windows there is no ACL-equivalence claim.
- **What leaves your machine** — confirmed sources only are sent to the model selected in your conversation (model-assisted drafting); the minimal intent fields only are sent read-only to the similarity sources (official Discussions feed, official `@deepseek-ai` npm registry data, a curated allowlist of official documentation); and only the five public draft fields, the feedback type, the submission language, and the chosen category are sent to GitHub on the single confirmed mutation. Raw messages, logs, and diagnostics never enter the exported or submitted Markdown unexamined.
- **Credentials** — GitHub tokens (Device Flow grant or GitHub CLI account token) are held only on the Host: access tokens live in Host memory for the duration of one request, and the Device Flow refresh token (when GitHub issues one) is persisted only in the DSH credentials store at `credentialKey('dsh-feedback-bridge', 'github-oauth')`. Neither ever reaches the Client, the model, or logs. The DSH local credentials provider is **not an operating-system security boundary** (the authorization dialog discloses this). The user code is shown only in the active authorization dialog.
- **Profile scope** — only the DSH `web` profile is supported in v0.1. DSH exposes no reliable profile-identity interface, so other profiles sharing the same `DSH_HOME` may observe the same draft file.
- **Advisory checks only** — sensitive markers on sources and privacy findings are advisory and read-only: they warn without auto-blocking, rewriting, redacting, or auto-publishing.

## Recovery

- **Draft** — edits autosave; a page reload or DSH restart resumes the in-progress draft with a “Restored your in-progress draft” notice. A corrupt or unknown-version draft file is quarantined beside the original rather than silently overwritten. Closing flushes any pending save; 取消 asks for an explicit confirmation before discarding, and a confirmed discard can never be undone by a late autosave.
- **Submission records** — a confirmed success persists a local record that survives reloads and reopens the stored official Discussion URL; records carry no draft body and no credentials.
- **Unknown submission result** — follow the in-dialog guidance and check the official Discussions manually.

## Persistence known limitations

- Only the DSH `web` profile is supported in v0.1. DSH exposes no reliable profile-identity interface, so other profiles sharing the same `DSH_HOME` may observe the same draft file.
- Only one in-progress draft exists at a time; there is no draft history and no submitted-record separation yet.

## Development

```sh
pnpm install
pnpm typecheck   # strict check of the Host and Client source trees
pnpm test        # builds lib/ from src/, then runs the full suite
```

`src/` is the single authoritative TypeScript implementation; `pnpm test` regenerates `lib/` (Host via tsc, Client bundle via esbuild) before running, so the suite always exercises the generated runtime artifacts. The acceptance tests pack the bundle, install it into a clean `DSH_HOME` Web profile, and boot DSH without a DeepSeek API key or GitHub account. The gh-backed submission acceptance test stands up a fake `gh` shim on PATH plus a local fake GraphQL server to drive account discovery, explicit selection, and the one-mutation confirm, and asserts the fake token never reaches the Client. The Device Flow acceptance test intercepts the browser handoff to a fake device page and never contacts real GitHub. The tests drive real headless-browser click-throughs of the left-navigation to export path (including Issue #6's model-assist flow: a test-only fake bundle intercepts the official `llm/stream` waterfall for hand-built calls to exercise structured success, malformed output, and provider failure deterministically, while one real credentialless path asserts graceful model-failed degradation) and assert zero GitHub and zero external network requests. The browser acceptance test requires Playwright's Chromium; install it once with `pnpm exec playwright-core install chromium`.
