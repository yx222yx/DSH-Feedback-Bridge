# Explicit GitHub CLI account selection behind the existing submission boundary

Issue #9 adds an advanced submission path that discovers the user's stored
GitHub CLI accounts, requires an explicit account choice when several exist,
and reuses the Issue #8 submission boundary for the single mutation.

## Context

- v0.1 ships without real GUI OAuth (ADR 0001 defers it); Issue #8 delivered a
  replaceable Host-side GitHub service whose authorization boundary is selected
  by validated config: `none` (shipped default, reports no identity) or
  `fake` (acceptance only). The mutation surface is exactly one
  `createDiscussion` against the pinned `deepseek-ai/deepseek-harness`
  Discussions, behind a one-shot nonce.
- Advanced users already authenticate with the GitHub CLI. Issue #1 requires
  that GitHub CLI reuse be explicit, that local Git or GitLab identity never
  count as authorization, and that tokens never reach the Client, the model,
  or logs.
- The primary runtime is DSH on Ubuntu under WSL2; native Windows is a
  secondary compatibility environment, so the gh runner must not assume
  Linux-only paths or spawn behavior.

## Decision

- **New gh provider, same boundary.** `github.auth` gains a third provider:
  `{provider: 'gh'}`. It sits behind the same `GitHubService` interface,
  the same `/dsh-feedback-bridge/submission` route, the same one-shot nonce,
  and the same `createDiscussion` mutation. There is exactly one submission
  path; no second GraphQL operation or endpoint is introduced.
- **Account discovery and token resolution live in one thin gh runner.**
  New module `src/host/gh-cli.ts` is the only place the plugin talks to the
  local `gh` binary: `gh auth status` (account names only, never
  `--show-token`) and `gh auth token -u <login>` (token into Host memory
  only). A run seam makes every command injectable for contract tests and
  Windows-focused spawn assertions.
- **GitHub CLI authorization only.** Discovery parses `gh`'s own auth store
  for github.com logins. The plugin has no code path that reads `git config`,
  repository metadata, or GitLab identity; only the gh runner is consulted.
- **Explicit selection when ambiguous.** A single stored account is
  auto-selected; when more than one exists, `prepare` returns
  `account-selection-required` with the login list and no network call. The
  Client shows a one-account form; the chosen login is then passed as the
  `account` query parameter, re-validated against a fresh discovery, and the
  prepared nonce snapshot binds that identity so the confirm mutation runs as
  the chosen account.
- **Token transport.** The selected account's token is attached only as the
  `Authorization: Bearer` header of the Host-to-GitHub fetch (the Issue #8
  fetch seam). It is never serialized into a route response, never placed in
  model input, never written to a draft or log, and is dropped after the
  request. gh child processes never run through a shell and never inherit
  ambient `GH_TOKEN`/`GITHUB_TOKEN`/model credential environment variables.
- **No global gh state changes.** The plugin never runs `gh auth switch`; a
  per-invocation `-u` token resolution keeps the user's terminal-wide active
  account untouched.
- **Distinct correction guidance.** `authorization-required` (no stored
  account), the new `authorization-expired` (token unusable or 401), and
  `permission-denied` (403) each render localized guidance (`gh auth login`
  or scope check) with the existing draft-export fallback.

## Consequences

- New Host module `src/host/gh-cli.ts`; `src/host/github.ts` gains the gh
  provider and the `authorization-expired` failure class; the submission
  route accepts the `account` query parameter and a
  `account-selection-required` response.
- Client transport `prepare(account)`, a select-account phase in
  `SubmitPanel`, and locale-owned copy in every shipped dictionary.
- Contract tests cover discovery parsing, explicit selection, token
  placement, expiry/insufficiency mapping, and the never-returned-token
  invariant; route tests cover the selection flow and nonce binding; the
  WSL2 acceptance test drives the full flow through a fake `gh` shim and
  asserts the token never reaches the browser.
- Windows portability is exercised by focused spawn-construction tests (no
  shell, credential-free env, kill-on-timeout) that run on any platform.
