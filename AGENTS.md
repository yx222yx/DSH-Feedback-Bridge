# DSH Feedback Bridge

DSH Feedback Bridge（DSH 社区反馈）is a DeepSeek Harness plugin that helps users turn feature ideas and bug reports into clear, privacy-aware GitHub Discussions.

## Before making changes

- Read `CONTEXT.md` for the project vocabulary and product boundaries.
- Read relevant decisions under `docs/adr/`.
- Read `docs/AGENTS.md` before implementing or changing DeepSeek Harness integration.
- Apply upstream DSH rules only where they are relevant to an independently maintained plugin; do not assume this repository has the upstream monorepo layout or release process.

## TypeScript baseline

- Treat `src/` TypeScript and TSX files as the only production-code source of truth. Add and change production code in TypeScript.
- Treat `lib/` as generated build output. Generate it through the repository build scripts; never edit or commit it by hand.
- Keep Host and Client compiler faces separate. Browser code must not import Node-only modules.
- Use official exported DeepSeek Harness and Cordis types where available. Keep any required local compatibility type narrow and document the missing upstream type it represents.
- Tests may remain JavaScript when that matches the existing test setup. Run type checking, the build, and relevant tests for production-code changes; verify the packed prebuilt JavaScript artifact for packaging changes.

## Project boundaries

- Keep the plugin compatible with the documented DeepSeek Harness plugin interfaces.
- Prefer DSH extension points over changes to DeepSeek Harness itself.
- Never submit a GitHub Discussion without explicit user confirmation.
- Treat conversation content, logs, repository metadata, credentials, and generated drafts as potentially sensitive.
- Show users what will be submitted and allow editing before any external write.
- Keep GitHub authentication and browser-assisted submission paths separate as recorded in `docs/adr/`.
- Use the current user-selected model; do not require a plugin-specific model.
- Preserve Chinese and English submission support, with English as the default when no language is selected.
- Keep v0.1 focused on preparing and submitting official DeepSeek Harness Discussions. Do not add follow-up monitoring or third-party plugin-repository submission without a later decision.

## Agent skills

### Issue tracker

Project engineering issues are tracked in `yx222yx/DSH-Feedback-Bridge` on GitHub. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels with their default names. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with `CONTEXT.md` at the root and ADRs under `docs/adr/`. See `docs/agents/domain.md`.
