# Domain Docs

This repository uses a single-context domain-documentation layout.

## Before exploring or changing the project

- Read `CONTEXT.md`.
- Read ADRs under `docs/adr/` that affect the area being changed.
- Read `docs/AGENTS.md` when the work involves DeepSeek Harness integration.

If a referenced document does not exist, proceed without inventing its contents.

## Vocabulary

Use the terms defined in `CONTEXT.md` in issues, specifications, code, tests and documentation. Avoid introducing synonyms for established domain concepts.

If a required concept is missing, record it as a domain-modeling gap rather than silently assigning it a new meaning.

## Architecture decisions

If proposed work conflicts with an existing ADR, identify the conflict explicitly. Do not silently override an accepted decision.

## Layout

```text
/
├── AGENTS.md
├── CONTEXT.md
└── docs/
    ├── AGENTS.md
    ├── agents/
    │   ├── domain.md
    │   ├── issue-tracker.md
    │   └── triage-labels.md
    └── adr/
```
