# DSH-Feedback-Bridge

一个 DeepSeek Harness 插件，帮助用户将功能想法和错误反馈整理为清晰、注重隐私的 GitHub Discussions。
A DeepSeek Harness plugin that helps users turn feature ideas and bug reports into clear, privacy-aware GitHub Discussions.

## v0.1 slice (Issue #2 and #3)

The current slice ships the installable `dsh.bundle` for the DSH `web` profile:

- Host plugin `dsh-feedback-bridge` loads once `webServer` is available and exposes
  `GET /dsh-feedback-bridge/status`.
- Client plugin registers a “DSH Feedback Bridge” status section in the Web GUI
  settings surface (plugin status only) and reads the Host status through that
  route.
- A dedicated **社区反馈** left-navigation entry in the Web GUI sidebar opens the
  community-feedback workspace: a custom-feedback draft with title, scenario,
  current gap or behavior, desired result, and additional context; an exact
  Markdown review card; copy-to-clipboard and .md export; and manual submission
  guidance linking to the official DeepSeek Harness Discussions. Copy, export,
  and cancel make zero GitHub writes and zero external network requests.
- The declared DSH compatibility range is `>=0.1.1-rc.2 <0.2.0`; an incompatible
  version fails with a clear message.

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
pnpm test
```

The acceptance tests pack the bundle, install it into a clean `DSH_HOME` Web
profile, and boot DSH without a DeepSeek API key or GitHub account. One test
drives a real headless-browser click-through of the complete left-navigation to
export path and asserts zero GitHub and zero external network requests. The
browser acceptance test requires Playwright's Chromium; install it once with
`pnpm exec playwright-core install chromium`.
