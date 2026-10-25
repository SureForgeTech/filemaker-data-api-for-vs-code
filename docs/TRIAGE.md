# Issue triage

Triage is the first maintainer look at a new issue: is it real, is it about this extension, and what happens to it. This page describes the labels, the queue, and the rules for closing an issue, waiting on one, or deferring one.

## What triage means

Issues arrive with the `triage` label already on them, because that is what the issue templates ask for. Triage starts when that label is on an open issue and ends when a maintainer has decided what the issue is and what should happen to it. Until then the issue sits in the triage queue.

The labels on an issue carry that decision:

- one **what it is** label, so the queue can be sorted by kind;
- `triage` while the issue is still in the queue;
- at most one **priority** label, so the queue can be sorted by urgency;
- at most one **status** label, so it is clear what the issue is waiting for.

A maintainer removes `triage` when triage finishes, whether the issue is scheduled, closed, or left open with a status label.

## Cadence

A maintainer looks at the triage queue at least once a week. During a release the queue is watched more closely: new issues are monitored for the week after the release ships, alongside the Marketplace Q&A and ratings (see [RELEASE.md](./RELEASE.md)).

## Security problems

Security problems are reported through the private channel in [SECURITY.md](../SECURITY.md) first. Once an issue about one exists in the tracker, triage labels it `security` like any other issue, and technical details stay out of the public tracker.

## The label set

Each issue carries one "what it is" label, plus `triage` until triage is finished and any close-reason labels such as `duplicate` that apply, plus at most one priority and at most one status.

The `priority/*` and `status/*` labels are created on the repository by the operator. A maintainer adds them like any other label.

### What it is

| Label | What it means |
| --- | --- |
| `bug` | The extension does not do what its documentation says, or does something the user did not ask for and cannot work around. |
| `enhancement` | A request for a new capability, or for existing behavior to change. |
| `question` | A request for information about using the extension. Not a defect and not a feature request. |
| `documentation` | The documentation is wrong, missing, or unclear. The code itself is fine. |
| `security` | The issue is about a security problem. See [Security problems](#security-problems) for how one reaches the tracker. |

### Priority

| Label | What it means |
| --- | --- |
| `priority/p0` | Drop everything: a leaked credential, lost data, or the extension not working at all. Answer the same day. |
| `priority/p1` | A confirmed defect that breaks a documented workflow, with no workaround. |
| `priority/p2` | A confirmed defect with a workaround, or a small, contained enhancement. |
| `priority/p3` | A cosmetic problem, a long-tail enhancement, or a question. |

### Status

| Label | What it means |
| --- | --- |
| `status/needs-info` | The issue cannot move until the reporter answers a question from a maintainer. |
| `status/blocked` | The issue cannot move until something outside it finishes: another issue or pull request, a FileMaker Server fix, a release, or a maintainer decision. |

### Close reasons

| Label | What it means |
| --- | --- |
| `duplicate` | Another issue already covers it. Link the two before closing. |
| `invalid` | It does not describe a problem with this extension, or it cannot be acted on as it stands and the reporter did not answer. |
| `wontfix` | The report is real, but the project will not act on it. Say why in the closing comment. |

### Other labels

| Label | What it means |
| --- | --- |
| `triage` | The issue is in the triage queue, waiting for its first maintainer look. It is on every new issue and comes off when triage finishes. |
| `good first issue` | The task is small and self-contained enough for a first-time contributor to take on. |
| `help wanted` | A maintainer wants help from outside the project on this issue. |

### Labels that automation owns

Labels in the `ai/*`, `risk:*`, and `build:*` families are set by automation, not by maintainers during triage; the `risk:*/build:*` shape falls under the same rule. Do not add them by hand, and do not use them to describe an issue's kind, priority, or status. The same rule covers the `ops/secret-rotation` label, which the credential-rotation reminder workflow manages on its own.

## Working an issue

### Close it

Use a close reason, and say why in a comment:

- `duplicate` — another issue covers it; link that issue.
- `invalid` — it is not a problem with this extension, or the report is too thin to act on and the reporter did not answer the questions asked.
- `wontfix` — it is real, but the project will not act on it now. Say what would change the answer, so the decision can be revisited later.

A close reason is not a priority decision: an issue closed as `wontfix` was still a real report.

### Ask for more information

When the issue cannot be reproduced or judged as it stands:

1. Add `status/needs-info`.
2. Ask in one comment for the specific missing facts: the extension version (FileMaker: About / Show Version), the VS Code version, the FileMaker Server version, the output-channel log with server addresses, user names, tokens, and secrets removed, and the steps to reproduce.
3. Leave the issue open and let the reporter answer.

If the reporter does not answer within two weeks, close the issue as `invalid` with a note that it can be reopened by replying with the missing details.

### Defer it

When the issue is understood and accepted, but the next step is not ours to take:

1. Add `status/blocked` and say what it is blocked on: another issue or pull request, a FileMaker Server fix, the next release, or a maintainer decision.
2. Leave the issue open. It is no longer in the triage queue, but it stays visible.

Re-check blocked issues when the blocker closes: the status label comes off, and the issue returns to the queue if it still needs a decision.

## Template defaults

The issue templates set the first labels, so a new issue is in the queue without a maintainer touching it:

| Template | Labels it applies |
| --- | --- |
| Bug report (`bug_report.yml`) | `bug`, `triage` |
| Feature request (`feature_request.yml`) | `enhancement`, `triage` |

Both defaults already exist in the issue templates. A maintainer adds the priority, status, and other labels during triage.

## Related pages

- Maintainers and responsibilities: [MAINTAINERS.md](./MAINTAINERS.md)
- Security reporting: [SECURITY.md](../SECURITY.md)
- Contributing: [CONTRIBUTING.md](../extension/CONTRIBUTING.md)
- Release process: [RELEASE.md](./RELEASE.md)
