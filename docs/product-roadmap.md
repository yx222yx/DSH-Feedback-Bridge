# DSH Feedback Bridge Product Roadmap

This document preserves product directions that are intentionally outside v0.1 but remain candidates for later work. They are not rejected features or release commitments. Each direction requires a separate design decision before implementation.

## v0.1 boundary

v0.1 helps novice and experienced DSH users turn a conversation into a reviewable community submission. Authorized submission targets only the official `deepseek-ai/deepseek-harness` GitHub Discussions. The flow ends after the user confirms the final preview, the Discussion is created, its permanent link is returned, and a local submission record is available in the GUI. Without GitHub authorization, the plugin exports a marked-up draft and manual submission guidance. The local record does not monitor or interpret remote activity.

## Priority 1: Developer inspiration radar

Developers should be able to discover unmet plugin needs without reading every Discussion manually. This direction is the highest-priority follow-up because the submission workflow creates structured demand that can later be made easier to discover and act on.

Candidate capabilities:

- Browse official Discussions that describe unmet plugin needs.
- Group related requests without automatically declaring them duplicates.
- Show source links, supporting users, activity, age, and current resolution state.
- Compare requests with known plugins and official Harness capabilities to identify plausible ecosystem gaps.
- Filter by capability area, target user, required permissions, target profile, and implementation complexity.
- Turn a selected demand cluster into a reviewable plugin-development proposal.
- Preserve traceability from a development proposal back to every source Discussion.

Questions to resolve before planning:

- Whether to integrate with an existing read-only Discussions radar or own the complete discovery experience.
- Which signals may rank opportunities without turning popularity into an automatic product decision.
- How to prevent duplicate grouping from hiding materially different user needs.
- Which plugin catalogs count as evidence that a need is already served.
- Whether developers can subscribe to a demand cluster and how notifications should work.

## Priority 2: Third-party plugin feedback

Extend routing beyond the official Harness Discussions so users can report defects or request changes in third-party plugin repositories.

Candidate capabilities:

- Resolve a plugin to its authoritative repository and supported feedback channel.
- Read and respect repository-specific templates, contribution rules, and enabled GitHub features.
- Distinguish a third-party plugin defect from a Harness defect or missing Harness extension point.
- Support authorized submission only when the destination, permissions, and user confirmation are all valid.
- Fall back to draft export whenever direct submission is unavailable or unsafe.

## Priority 3: Post-submission collaboration

Continue helping after a Discussion has been created, without silently acting on the user's behalf.

Candidate capabilities:

- Reopen the original feedback context from its permanent Discussion link.
- Refresh and display remote Discussion or Issue status separately from the immutable local submission record.
- Draft answers to developer questions and proposed clarifications.
- Prepare edits or follow-up comments for explicit user confirmation.
- Track status changes and notify the user when they have opted in.
- Link an accepted request to a resulting plugin, release, or documentation answer.

Autonomous comments, edits, subscriptions, monitoring, and notifications remain outside v0.1.

## Priority 4: Additional Harness profiles

v0.1 targets the `web` profile because its core experience depends on the DSH GUI. Later work may expose appropriate parts of the same feedback workflow through `headless`, `sdk`, or `acp`, but each profile requires its own interaction, authorization, output, and acceptance design rather than inheriting Web behavior implicitly.

## Priority 5: Public attachments

Direct v0.1 submission is Markdown-only because GitHub's public Discussion mutation does not upload binary attachments. Later work may add a supported public-attachment path only if it has an explicit upload API, permission model, retention and deletion ownership, content validation, privacy preview, and stable URL contract; browser-private GitHub upload endpoints and session cookies are not acceptable dependencies.

## Promotion rule

A roadmap direction enters a release scope only after its users, outcome, evidence sources, permission boundary, privacy behavior, and acceptance criteria have been discussed and approved. Roadmap ordering expresses current product importance, not a promised release sequence.
