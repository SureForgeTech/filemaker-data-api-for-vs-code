# Agent instructions: filemaker-data-api-for-vs-code

<!-- fleet-core:begin (generated: edit the fleet source, not this block) -->
## Fleet core

Applies to every repository in the fleet. It is generated from one source; repository-specific rules go outside the markers.

### Evidence
- Read live state before stating it: fetch the remote, read the default branch, run the command. A number or an "X is missing" taken from a doc or a stale checkout is a claim to verify. A figure in a doc carries its date and how it was read.
- Find the root cause before proposing a remedy. For an unreachable or hung host, check its network interface and the previous boot's log before blaming memory.
- Give one account of a fact. If two places disagree, fix or flag one.
- Say plainly what you did not verify.

### Changes
- One bounded task per change request. Stay in scope: no drive-by edits and no agent scratch files committed.
- Run the repository's validation (named below) before pushing.
- A change request merges when a fresh-context review of the exact head has no unresolved P0 or P1 findings and every required check is green. A new commit needs a new review; a clean automatic merge of the base branch keeps the review.
- At most three open non-draft change requests per repository. While the fleet backlog check reports a backlog, finish and land existing work and start nothing new.
- Fix a finding that takes minutes in the current change; fold the rest into an existing tracking issue. A session closes at least as many issues as it opens on its own initiative; tickets the owner asks for in chat are separate.

### Safety
- Never print, log or commit tokens, passwords or keys. Use the credential helper the repository names.
- One writer per checkout: separate worktrees for separate writers. Do not force-push, rebase or delete a branch another session may own.
- Private repositories run CI on self-hosted runners only. A job that must not share a host (for example signing) runs on a dedicated self-hosted runner group, never on a GitHub-hosted runner without the owner's approval.
- Ask the owner only for a step no agent can do or for a spend or legal commitment; decide and record everything else.

### Layout
- AGENTS.md is the canonical agent file; where a CLAUDE.md exists it only imports it. Keep this file under 200 lines.
- Name this repository's validation command, merge rule and changelog rule outside the markers. Rules kept outside the repository are not visible here: if a task seems to need one, ask rather than guess.
- Shared skills are installed per machine from the fleet skills hub. Name the ones this repository expects below.

### Forge: GitHub
- Prefer REST (`gh api repos/OWNER/REPO/...`) to GraphQL for single reads: the rate-limit pools are shared by every session on the account.
- Required checks and review rules are branch protection or rulesets; read them with `gh api`. Review-thread resolution needs GraphQL.
<!-- fleet-core:end -->

## Repository-specific

- **Validation:** `npm ci`, `npm run lint`, `npm run typecheck`, `npm run mock:check -w extension`, `npm run test:coverage`, `npm run build`, `npm test -w designer-ui -w runtime-next`, and `npm run package:check`; CI also runs `npm audit --omit=dev --audit-level=high` and the VSIX size check. Run the relevant full gate before delivery.
- **Layout:** `extension/` is the VS Code extension; `shared/` contains shared contracts and renderer utilities; `designer-ui/` is the Layout Mode webview; `runtime-next/` is the FM Web template; `docs/` contains maintainer and security guidance.
- **Skills:** no repository-specific skills beyond the shared fleet skills hub defaults.
- **Changelog:** user-visible changes update `extension/CHANGELOG.md` and the root `CHANGELOG.md` in plain words; release changes follow `docs/RELEASE.md`.
- **Merge:** a fresh independent review of the exact head must have zero unresolved P0/P1 findings and all required checks must be green. Do not merge a changed head without a fresh review.
- **Agent workflow:** Ordinary agent work, including OpenCode sessions, uses the normal branch, validation, commit, push and pull-request workflow. SureForge supervision is optional unless the owner or an adopter explicitly selects it for the task; a missing SureForge executable, wrapper or contract does not block ordinary work. Preserve existing active contracts: inside a supervised run, its contract and delivery process govern commits and publication, and agents must not commit, push, switch branches, stash or change Git config themselves. This changes no merge requirement: independent exact-head review, resolved blocking threads and green required checks remain mandatory. Contracts and operator wrappers stay outside the repository. Use a fresh linked worktree and an unprotected branch; never commit on the default branch.
- **Safety:** never expose FileMaker credentials or real customer data. Treat repository settings, templates, generated files and webview input as untrusted. Preserve exact layout, script and field names; do not trim them. Real-server QA is read-mostly and must use the approved guard proxy and leak scan.
