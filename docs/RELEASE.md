# Release process

How a version of **FileMaker Data API Tools** (`SureForgeTech.filemaker-data-api-tools`) goes from `main` to the Marketplace. A release is more than code: the checklist below covers the user guide, upgrade notes, the Marketplace listing, support and follow-up as well as the build.

Related: [release cadence](./RELEASE_CADENCE.md) (when and how big), [rollback](./ROLLBACK.md) (when it goes wrong), [Entra publishing setup](./JOB_AID_ENTRA_PUBLISHING.md), [CI and budgets](./CI.md).

## How publishing works

Pushing a tag named `vX.Y.Z` starts the **CI** workflow (`.github/workflows/ci.yml`). For a tag it runs four jobs in order:

1. **build-test**: install, audit, lint, typecheck, tests with coverage, build, package check and the VSIX size budget. This is the required check on `main` as well.
2. **package**: builds the VSIX and uploads it as the run artifact `extension-vsix`.
3. **publish**: waits for approval of the **`marketplace`** environment (a required reviewer). It then checks that the tag points at a commit on `main` and that the tag equals `v` plus the version in `extension/package.json`. It installs `vsce` from the pinned lockfile in `tools/publish`, signs in to Azure with a short-lived GitHub OIDC token (Microsoft Entra ID, no stored token) and runs `vsce publish --azure-credential`.
4. **release**: only after publish succeeds, creates the GitHub release with the VSIX and the source maps tarball (`sourcemaps-<tag>.tgz`) attached and notes taken from `extension/CHANGELOG.md` by `tools/release-notes.sh`.

Tags matching `v*` are protected by a repository ruleset (creation, update and deletion are limited to repository admins). Create the tag as an admin, from `main`.

### Current state of Marketplace publishing

The Entra identity is not set up yet (the `marketplace` environment has no `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` variables), so the **publish** job stops at "Require the Azure identity settings" and **release** is skipped. Until the one-time setup in [JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md) is done, publish by hand: see [Manual publish](#manual-publish-fallback). Do the setup before 2026-12-01, when Microsoft stops accepting the personal access tokens that `vsce` used.

Versions 1.2.0 and 1.3.0 were published by manual upload and were never tagged. Tags `v1.0.0`, `v1.1.0` and `v1.6.0` exist. Version 1.4.0 was also published by hand, and so were 1.5.0 and 1.6.0 (1.4.0 and 1.5.0 have no tag or GitHub release; see [JOB_AID_MANUAL_RELEASE.md](./JOB_AID_MANUAL_RELEASE.md)). Version 1.7.0 is on the Marketplace but has no tag and no GitHub release (checked 2026-10-25).

## Versioning

Follow semver, as it applies to an extension. The version in `extension/package.json` is the Marketplace version (the root `package.json` version is not).

- **Patch (`1.4.x`)**: bug fixes, documentation corrections, dependency bumps that do not change behavior.
- **Minor (`1.x.0`)**: new features, commands, settings or walkthroughs; compatible. Changes of defaults that users will notice are listed in the upgrade notes.
- **Major (`x.0.0`)**: removed commands or settings without a migration, changed stored formats. Write the migration path in [extension/UPGRADE.md](../extension/UPGRADE.md) first.

The pull request titles (`[patch]`, `[minor]`, `[major]`) predict the bump: the highest label wins.

## Release checklist

Copy this into the release pull request. Items marked **non-code** are the ones that are easy to forget.

### 1. Decide the scope

- [ ] Read the merged pull requests since the last release: `git log vPREVIOUS..origin/main --oneline` (1.2.0 and 1.3.0 have no tags; 1.7.0 also has no tag, so for 1.8.0 use `git log db6b222..origin/main --oneline`, since db6b222 is the 1.7.0 release commit).
- [ ] Pick the version from the highest-tier change (see Versioning). Do not release only to meet a date.
- [ ] Check open pull requests and issues for anything that must ship, or must not.

### 2. Prepare the release pull request

Branch from green `main`: `git switch -c release/vX.Y.Z origin/main`. For this release use `codex/release-1.8.0`, version `1.8.0`, date `2026-10-25` and title `[minor] Release 1.8.0`. The upgrade heading is **Upgrading from 1.7.0 to 1.8.0**. The release commit is not known until that pull request merges; the job aid finds it then. Local preparation alone does not establish that CI is green.

- [ ] **Version.** `npm version X.Y.Z --no-git-tag-version -w extension`. This changes `extension/package.json` and the `extension` entry in the root `package-lock.json`. Confirm both.
- [ ] **Changelog.** In [extension/CHANGELOG.md](../extension/CHANGELOG.md), rename `## Unreleased` to `## X.Y.Z` (exactly that heading: `tools/release-notes.sh` matches it as written, so do not add a date to the heading) and put the release date on the first line under it, for example `_Released 2026-10-20._`. Add a fresh empty `## Unreleased` above it. This file becomes both the GitHub release notes and the Marketplace Changelog tab.
- [ ] **Root ledger.** In [CHANGELOG.md](../CHANGELOG.md), rename `## Unreleased` to `## X.Y.Z (date)` and add a new `## Unreleased` with the five empty sections. Remove entries that shipped in an earlier version.
- [ ] Run `tools/release-notes.sh vX.Y.Z` and read the output. Is it understandable to a user who does not know the code? Edit the changelog, not the script.
- [ ] **User guide (non-code).** Every new or changed command, setting, prompt or behavior is in [extension/docs/USER_GUIDE.md](../extension/docs/USER_GUIDE.md), including the settings reference. Update the "What's new" section for this version. Open the guide in VS Code (**FileMaker: Open User Guide**) and check it renders.
- [ ] **Command and setting names (non-code).** Every command title and setting key named in the docs exists in `extension/package.json`.
- [ ] **READMEs (non-code).** [extension/README.md](../extension/README.md) (the Marketplace page) and the root [README.md](../README.md) mention new features, do not promise unshipped ones, and have working links.
- [ ] **Upgrade notes (non-code).** [extension/UPGRADE.md](../extension/UPGRADE.md) has a section for the new version listing every behavior change: new prompts, changed defaults, renamed or removed commands and settings, changed file names, new policy rules, anything that needs action from a user or administrator, and how to roll back.
- [ ] **Walkthroughs (non-code).** The Getting Started steps in `extension/docs/walkthroughs/` still match the screens.

  1.8.0 preparation: no walkthrough file changed since 1.7.0, so the inspection below still describes them and no image was regenerated. 1.7.0 preparation: the walkthrough text and local image files were inspected without opening VS Code. `about.png` shows version 1.4.0; `connection-setup.png` and `explorer.png` also show the old sidebar version. `record-editor.png` predates the shared field presentation and still shows a light panel in a dark editor; `layout-mode.png` predates the standards/template controls and theme support, and shows alphabetic field order. `schema-diff.png` and `chat-participant.png` show old version labels. `query-builder.png` and `copy-as-code.png` still illustrate the described populated search and copy menu, but do not show the new empty-search choice or export choices. No images were regenerated. Screen rendering and a full walkthrough still need a manual check.

- [ ] **Security and data handling (non-code).** [docs/security.md](./security.md) and [docs/DATA_HANDLING.md](./DATA_HANDLING.md) describe what the release stores, sends and asks. Check what changed against the list: new settings that widen access, new files written, new network calls, new prompts, new secrets.
- [ ] **Marketplace listing (non-code).** In `extension/package.json`: description, `keywords`, `categories`, `icon`, `homepage`, `bugs`. In the README: screenshots in `extension/docs/marketplace/` still show the product and the files exist (the listing loads them from `main` on GitHub, so do not rename or delete one later). Nothing in the listing may describe a feature that is off by default without saying so, or one that is not in this release.
- [ ] **Failure-mode catalogue (non-code).** If error handling or connection behavior changed, update the status table in [FILEMAKER_FAILURE_MODES.md](./FILEMAKER_FAILURE_MODES.md) and the guide's Troubleshooting section, and say which rows still need a real-server check.
- [ ] **1.8.0 evidence.** No server exercise is recorded for 1.8.0. The last recorded exercise was on 2026-10-21, during 1.7.0, and its version was not recorded, so it does not complete any named server version's smoke test. FileMaker Cloud / Claris ID sign-in is not supported. Record remaining manual checks rather than claiming a test run that did not happen.
- [ ] **Compatibility.** [extension/docs/COMPATIBILITY.md](../extension/docs/COMPATIBILITY.md) lists the server versions you actually tested.
- [ ] **Third-party notices.** If dependencies changed, run `npm run notices -w extension` and commit `extension/THIRD_PARTY_NOTICES.txt` (it ships in the VSIX; `package:check` fails when it is out of date).
- [ ] **Dependencies.** `npm audit --omit=dev --audit-level=high` is clean (CI enforces it). Review the Dependabot pull requests that would otherwise land right after the release ([dependency policy](./CI.md)).
- [ ] Push the branch and open the pull request titled `[patch] Release X.Y.Z` (or the tier that matches). Mark it draft or hold the merge: verify first (next section), then merge.

### 3. Verify the build, on the release branch, before merging

Do this against the release branch (the content that will be tagged), not after the merge. Merging puts the version bump on `main`; the tag follows quickly, and a problem found afterwards costs a patch release.

- [ ] `build-test` is green on the release pull request.
- [ ] On a clean machine or profile, from the release branch, `npm ci && npm run build && npm run package:check` (the package check fails on a clean checkout until the build has run) and install `artifacts/filemaker-data-api-tools-X.Y.Z.vsix`.
- [ ] Run the [smoke test](../extension/docs/QA/SMOKE_TEST.md) against a real FileMaker Server (check 5, Test Connection, needs one: the current mock does not implement `productInfo` or `/databases`, so Test Connection stops at step 1 against it; use a complete mock once one is merged). Other checks can use `npm run mock:server -w extension`. Note which you used.
- [ ] Run the checks that matter for this release's changes. For a release with a security change, try the failure path too (for example open a repository with a hostile settings file).

### 4. Merge and publish

- [ ] Merge the release pull request once the verification above passed and `build-test` is green. Do not add code after verifying; if you must, verify again.
- [ ] Make sure the release commit is on `origin/main` and `extension/package.json` has the new version there: `git fetch origin && git show origin/main:extension/package.json | grep '"version"'`.
- [ ] Create and push the tag from `main` (as a repository admin):
  ```bash
  git fetch origin
  git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
  git push origin vX.Y.Z
  ```
  The tag must point at the commit whose `package.json` says `X.Y.Z`; the publish job refuses anything else.
- [ ] Watch the run. When **publish** waits, open the run, choose **Review deployments**, tick **marketplace** and approve. (If the Entra setup is not done, publish by hand instead; see below.)
- [ ] **release** creates the GitHub release with the VSIX, `sourcemaps-vX.Y.Z.tgz` and the changelog text. Open it and read it.

### 5. Verify after publishing

- [ ] The docs site rebuilds on every push to main; open the [changelog page](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/changelog/) and confirm the new version appears.

- [ ] The Marketplace page shows the new version and the new changelog (it can take up to about 10 minutes): `npx @vscode/vsce show SureForgeTech.filemaker-data-api-tools`, or the [listing](https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools).
- [ ] The version is queryable from the Marketplace API (the same thing the listing serves): `curl -s -o /dev/null -w "%{http_code}" https://marketplace.visualstudio.com/_apis/public/gallery/publishers/SureForgeTech/vsextensions/filemaker-data-api-tools/X.Y.Z/vspackage` must print `200`. The publisher id is `SureForgeTech` (from extension/package.json), not the old `deffenda` id. A `404` means the version has not propagated yet or the version string is wrong; wait and retry as in the item above before assuming the publish failed.
- [ ] Screenshot the Marketplace listing page (the description preview and the top of the README as a visitor sees them) and keep it with the release records, so a later listing problem can be compared.
- [ ] The README on the listing renders, images load, and links work (click them; they are rewritten to GitHub URLs when the VSIX is built).
- [ ] **FileMaker: About / Show Version** in the published build shows the version you released.
- [ ] In a clean VS Code profile, install from the Marketplace, check `code --list-extensions --show-versions`, connect, run one find, and open **FileMaker: Open User Guide**.
- [ ] Update from the previous version in a profile that has the old version installed: profiles and settings survive, and the new prompts behave as the upgrade notes say.
- [ ] The GitHub release has the VSIX and `sourcemaps-vX.Y.Z.tgz` attached. Keep the tarball: it is the only way to read a stack trace from the minified bundle.

### 6. Announce, support and monitor

- [ ] **Announce (non-code).** Post the release notes where users look: the GitHub release is the canonical text. If the release matters to the wider FileMaker community, post a short note in the places they read (for example Claris Community and FMSoup), linking the release and the upgrade notes. Say what changed for the reader, not how it was built.
- [ ] **Support readiness (non-code).** The primary maintainer (see [MAINTAINERS.md](./MAINTAINERS.md)) is available for the first week. The issue templates ask for the extension version, VS Code version and log; confirm they still do. Know what the likely questions are from the upgrade notes (policy, prompts, file names) and have the answers linked.
- [ ] **Monitor for a week (non-code).** Watch new GitHub issues (`bug`, `triage`), the Marketplace Q&A and ratings tabs, and the publisher page at <https://marketplace.visualstudio.com/manage> for installs and uninstalls. The extension has no telemetry, so these are the only signals. A spike in uninstalls or the same issue three times is a reason to patch. If the release is unsafe or broken, follow [ROLLBACK.md](./ROLLBACK.md).
- [ ] Close the milestone or tracking issue, and move anything deferred to the next release's notes.
- [ ] If anything went wrong in the process, fix this document in the same week.

## Manual publish (fallback)

Use this when Entra publishing is not set up (today) or the publish job failed. The step-by-step, copy-paste version, with the checks and the safest order for the GitHub release, is **[JOB_AID_MANUAL_RELEASE.md](./JOB_AID_MANUAL_RELEASE.md)**. In short:

1. Build the VSIX from the merged release commit (`npm ci && npm run build && npm run package:check`), and verify its version, file list (no source maps) and sha256. Make `sourcemaps-vX.Y.Z.tgz` from `extension/dist/*.map`.
2. Upload the `.vsix` at <https://marketplace.visualstudio.com/manage> and wait for verification.
3. Create the tag at the recorded release commit (`git tag -a vX.Y.Z -m vX.Y.Z <sha> && git push origin vX.Y.Z`, as an admin), then create the GitHub release on it with `gh release create vX.Y.Z --verify-tag ...` and the same files. The tag starts the tag run in CI; **reject** its `marketplace` deployment (the publish job would only fail at the Azure check) instead of approving it.
4. Continue with step 5 of the checklist. Say in the pull request that the release was published by hand, and why.

## Pre-releases

The Marketplace does not accept semver suffixes such as `1.5.0-pre.1`. A pre-release is an ordinary version published with `vsce publish --pre-release`, and Microsoft recommends odd minor numbers for pre-releases and even ones for stable. This project has never published a pre-release, uses consecutive minor numbers, and the CI publish job publishes stable only, so a pre-release would need a decision on the version scheme and a manual publish. Do not start one without writing that decision down (see [RELEASE_CADENCE.md](./RELEASE_CADENCE.md)).

## Source maps

The shipped bundles (`dist/extension.js`, the schema-diff worker and the MCP shim) are minified
and carry **no source map**. `scripts/esbuild-config.mjs` writes an *external* map next to each
bundle (`dist/*.js.map`), and `.vscodeignore` keeps `dist/**/*.map` out of the VSIX. The Layout
Mode UI is built minified with no map at all.

The tagged `package` job in `.github/workflows/ci.yml` collects the maps from the very build that
produced the VSIX into `sourcemaps-<tag>.tgz`, and the `release` job attaches it to the GitHub
release next to the VSIX. To symbolicate a stack trace from a user report, download that asset
for the same tag, unpack it, and point your tool (for example `source-map-support` or a browser
devtools "add source map") at `dist/extension.js.map`. A map only matches the exact build it
came from, so always use the asset from the tag the user reported.
