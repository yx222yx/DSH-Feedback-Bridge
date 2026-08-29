# DSH-Feedback-Bridge

一个 DeepSeek Harness 插件，帮助用户将功能想法和错误反馈整理为清晰、注重隐私的 GitHub Discussions。
A DeepSeek Harness plugin that helps users turn feature ideas and bug reports into clear, privacy-aware GitHub Discussions.

## v0.1 slice (Issue #2)

The current slice ships the smallest installable `dsh.bundle` for the DSH `web` profile:

- Host plugin `dsh-feedback-bridge` loads once `webServer` is available and exposes
  `GET /dsh-feedback-bridge/status`.
- Client plugin registers a “DSH Feedback Bridge” status section in the Web GUI
  settings surface and reads the Host status through that route.
- The declared DSH compatibility range is `>=0.1.1-rc.2 <0.2.0`; an incompatible
  version fails with a clear message.

## Install

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.0.tgz
dsh --profile web --no-open --port 3080
```

Then open `http://127.0.0.1:3080/dsh-feedback-bridge/status` to see the Host
status payload.

## Test

```sh
pnpm install
pnpm test
```

The acceptance test packs the bundle, installs it into a clean `DSH_HOME` Web
profile, boots DSH without a DeepSeek API key or GitHub account, and checks the
served status and client bundle.
