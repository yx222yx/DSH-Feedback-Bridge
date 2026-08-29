# Issue tracker: GitHub

Engineering issues and specifications for this repository live in GitHub Issues:

https://github.com/yx222yx/DSH-Feedback-Bridge

Use the `gh` CLI for issue operations and explicitly target `yx222yx/DSH-Feedback-Bridge` when the local Git remote is unavailable or ambiguous.

## Conventions

- Create: `gh issue create --repo yx222yx/DSH-Feedback-Bridge`
- Read: `gh issue view <number> --repo yx222yx/DSH-Feedback-Bridge --comments`
- List: `gh issue list --repo yx222yx/DSH-Feedback-Bridge`
- Comment: `gh issue comment <number> --repo yx222yx/DSH-Feedback-Bridge`
- Label: `gh issue edit <number> --repo yx222yx/DSH-Feedback-Bridge`
- Close: `gh issue close <number> --repo yx222yx/DSH-Feedback-Bridge`

All external writes require explicit user authorization.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests are not treated as feature requests or included in the triage queue.

## Skill terminology

- “Publish to the issue tracker” means creating a GitHub Issue.
- “Fetch the relevant ticket” means reading the corresponding GitHub Issue and its comments.
- Issue planning maps and child tickets use GitHub issues, sub-issues and native dependencies when available.
