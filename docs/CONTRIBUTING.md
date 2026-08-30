# Contributing / 参与贡献

Thank you for helping improve DSH Feedback Bridge. 感谢你帮助改进 DSH 社区反馈。

## Report a problem or suggest an improvement

Open a [GitHub Issue](https://github.com/yx222yx/DSH-Feedback-Bridge/issues) and include:

- what you expected;
- what happened instead;
- your DeepSeek Harness and plugin versions;
- steps or a small example that reproduces the problem;
- logs or screenshots only after removing credentials and private content.

如需报告问题或提出建议，请创建 GitHub Issue，并说明预期结果、实际情况、版本和复现步骤。上传日志或截图前，请先删除凭据和隐私内容。

## Code changes

Before changing code, read the root `AGENTS.md`, `CONTEXT.md`, and the relevant decisions under `docs/adr/`.

Production code is TypeScript under `src/`. Tests may remain JavaScript. Keep each change focused and run:

```sh
pnpm typecheck
pnpm test
```

Do not use real GitHub writes or real model credentials in automated tests. Every direct Discussion submission must remain behind an explicit final user confirmation.
