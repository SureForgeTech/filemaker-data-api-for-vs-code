# Job aid: publish a release by hand

**When:** the Microsoft Entra publishing setup ([JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md)) is not done, so the `publish` job in CI cannot run. You build the `.vsix` yourself, upload it to the Marketplace, and create the GitHub release from the same file. **Time:** about 20 minutes. **Who:** a repository admin who is also an owner of the SureForgeTech publisher.

Written for version `1.8.0` (the steps are the same for any version: replace the number). "Checked" below means checked against the named page on 2026-10-19; anything not on an official page is marked **unverified**.

## Before you start

- The release pull request (`[minor] Release 1.8.0`) is **merged**. The release commit for 1.8.0 is the merge commit of that pull request (the commands below find it; write it down in the release pull request once merged). Later merges to `main` do not matter, because the steps below pin that commit; a build from any later commit would be a different VSIX.
- You are signed in to `gh` (`gh auth status`) as an admin of `SureForgeTech/filemaker-data-api-for-vs-code`, and you can sign in at <https://marketplace.visualstudio.com/manage> as an owner of the publisher.
- Node.js 22 or newer and `git`.
- **The release date.** The notes say `_Released 2026-10-22._`: that is the day the release was prepared, not necessarily the day you publish. The Marketplace and GitHub show the real publish date. If you publish on a later day, leave the text as it is (changing it after the merge would mean another change on `main` and a different VSIX); if you want the date to match, merge a one-line change to that date in `extension/CHANGELOG.md` and `CHANGELOG.md` first and use that merge commit.

## 1. Build the VSIX from the merged commit

```bash
git clone https://github.com/SureForgeTech/filemaker-data-api-for-vs-code.git release-1.8.0   # or use a clean checkout
cd release-1.8.0
git fetch origin
# RELEASE_SHA is the merge commit of the release PR ("[minor] Release 1.8.0"). Confirm it matches the
# "merged commit" link on the merged PR page on GitHub, and use this same value everywhere below.
RELEASE_SHA="$(git log origin/main --format=%H -1 --grep='^\[minor\] Release 1\.8\.0')"
git checkout --detach "$RELEASE_SHA"
git log -1 --oneline                     # confirm: this is the release commit
git merge-base --is-ancestor "$RELEASE_SHA" origin/main && echo "on main"
grep '"version"' extension/package.json  # must say 1.8.0
npm ci
npm run build
npm run package:check
```

`package:check` first checks that `extension/THIRD_PARTY_NOTICES.txt` is current and then runs `vsce package`. The file is written to `artifacts/filemaker-data-api-tools-1.8.0.vsix` (the file count and size can change; CI enforces a 3 MiB budget; check it below too).

Verify it:

```bash
ls -l artifacts/*.vsix
test "$(wc -c < artifacts/filemaker-data-api-tools-1.8.0.vsix)" -le 3145728  # at most 3 MiB
(cd artifacts && shasum -a 256 filemaker-data-api-tools-1.8.0.vsix > SHA256SUMS.txt && cat SHA256SUMS.txt)   # on Linux: sha256sum
(cd artifacts && shasum -a 256 -c SHA256SUMS.txt)                                                              # must print: ...vsix: OK
unzip -p artifacts/filemaker-data-api-tools-1.8.0.vsix extension/package.json | grep '"version"'   # "version": "1.8.0"
unzip -l artifacts/filemaker-data-api-tools-1.8.0.vsix | grep -c '\.map$'                         # 0: no source maps in the VSIX
```

Also make the source-map archive (the same command the CI job runs; it is the only way to read a stack trace from the minified bundle, so keep it):

```bash
mkdir -p artifacts/maps
(cd extension/dist && tar -czf ../../artifacts/maps/sourcemaps-v1.8.0.tgz ./*.map)
```

Do not rebuild between steps 1 and 3: the file you upload to the Marketplace and attach to the GitHub release must be the same bytes (compare the sha256).

Sources: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> (checked 2026-10-19: `vsce package` creates the `.vsix`; the manual upload goes to the publisher management page, and the page gives no menu names).

## 2. Upload the VSIX to the Marketplace by hand

1. Open <https://marketplace.visualstudio.com/manage> and sign in with the Microsoft account that owns the **SureForgeTech** publisher.
2. Open the **FileMaker Data API Tools** extension. Choose the action to update it with a new package and select `artifacts/filemaker-data-api-tools-1.8.0.vsix`.
3. Wait for verification to finish. The Marketplace validates the package and then shows the new version.

What Microsoft documents: the publishing guide only says to upload the `.vsix` on the "Visual Studio Marketplace publisher management page" and shows a screenshot titled "Add an extension through management page". **The exact menu and button names for updating an existing extension (typically a "..." menu on the extension row with an update action) are unverified**: follow what the page shows. Use a version number that has not been used: the guide says a deleted version's number cannot be reused (checked). Use `1.8.0` for this release, following the recorded 1.7.0 release. Check the live Marketplace version before uploading; it has not been re-checked for this preparation.

If the upload is rejected, read the message on the page. A version that is not higher, a missing icon, or a manifest error are the usual causes; do not change the version to get around it without telling the team.

## 3. Create the GitHub release without a failing publish run

**What a tag does here.** `ci.yml` runs on every pushed `v*` tag: `build-test`, then `package`, then `publish` (which waits for the `marketplace` environment's approval, then fails at "Require the Azure identity settings" because `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are not set), then `release` (skipped when `publish` fails). So **any `v1.8.0` tag, however created, starts that run**. Only repository admins can create `v*` tags (ruleset `release-tags`); you are one.

Checked 2026-10-19 (<https://cli.github.com/manual/gh_release_create>): without `--verify-tag`, `gh release create` creates a missing tag itself from the default branch's latest state, which is the wrong commit if `main` has moved. `gh release create` makes the tag itself when it does not exist, and GitHub's events page does not say whether such a tag fires the `push` trigger (unverified). So the sequence below creates the tag first, on purpose, and then attaches the release to it with `--verify-tag`.

**Safest sequence** (kept simple because whether a release creates its tag early or late is not documented)

1. Upload to the Marketplace first (step 2) and confirm the version is live, so a problem there does not leave a GitHub release pointing at a version users cannot install.
2. Create the tag yourself, at the release commit (an admin bypasses the `release-tags` ruleset):

   ```bash
   git tag -a v1.8.0 -m "v1.8.0" "$RELEASE_SHA"
   git push origin v1.8.0
   ```

3. Create the release on that existing tag. `--verify-tag` makes `gh` stop instead of creating a tag if it is missing (checked: <https://cli.github.com/manual/gh_release_create>):

   ```bash
   bash tools/release-notes.sh v1.8.0 > artifacts/RELEASE_NOTES_v1.8.0.md
   wc -l < artifacts/RELEASE_NOTES_v1.8.0.md                                   # more than 15 lines, never 0
   grep -c 'Upgrading from 1.7.0 to 1.8.0' artifacts/RELEASE_NOTES_v1.8.0.md   # must print 1
   gh release create v1.8.0 \
     --repo SureForgeTech/filemaker-data-api-for-vs-code \
     --verify-tag \
     --title v1.8.0 \
     --notes-file artifacts/RELEASE_NOTES_v1.8.0.md \
     artifacts/filemaker-data-api-tools-1.8.0.vsix \
     artifacts/maps/sourcemaps-v1.8.0.tgz \
     artifacts/SHA256SUMS.txt
   ```

   Read the release on GitHub: notes, and the three files attached.
4. Pushing the tag in step 2 started a `CI` run for `v1.8.0`. It runs `build-test` and `package` and then waits at `publish`. **The Reject button does not exist at first.** It appears only after the `build-test` and `package` jobs finish, a few minutes after the tag push (the run page then shows `publish` as waiting). Wait for it; do not approve in the meantime. Then **open the run, choose Review deployments, tick `marketplace`, and click Reject** (checked 2026-10-19 against <https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments>: the buttons are "Approve and deploy" and "Reject"; rejecting makes the run fail). The run ends red; that is expected. Do not approve it: the publish job cannot publish (the Azure variables are unset) and the `release` job would try to create a release that already exists.
5. The tag run also builds the VSIX in CI (artifact `extension-vsix`). Its bytes differ from yours (build time stamps), so compare the version and file list, not the hash.

There is no supported way to avoid that red run with the current workflow (the release jobs run only for tags; CI also runs on pull requests and pushes to `main`); the Entra setup removes the problem. A draft release or `--target` does not avoid it either, and when the tag appears in those cases is undocumented, so they are not used here.

## 4. After publishing

- The docs site rebuilds on every push to main; open the [changelog page](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/changelog/) and confirm the new version appears.

- <https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools> shows **1.8.0** (it can take several minutes) and its **Changelog** tab shows the 1.8.0 section. Or run `npx @vscode/vsce show SureForgeTech.filemaker-data-api-tools` (checked: `vsce show <extensionid>` exists in vsce 4.0.0).
- In a clean VS Code profile, install it from the Marketplace and run **FileMaker: About / Show Version**: it must say 1.8.0 and a build. (`code --user-data-dir /tmp/fm-user --extensions-dir /tmp/fm-ext --install-extension SureForgeTech.filemaker-data-api-tools`.)
- Run the [smoke test](../extension/docs/QA/SMOKE_TEST.md) checks 1 to 12 against a real FileMaker Server.
- Watch issues and the Marketplace Q&A for a week (see [RELEASE.md](./RELEASE.md), step 6).
- Record in the release pull request that the release was published by hand, with the sha256 and the release commit SHA.

## Still outstanding from 1.4.0: the tag and GitHub release

1.4.0 is on the Marketplace (uploaded by hand 2026-10-18) but **no `v1.4.0` tag and no GitHub release exist** (checked 2026-10-22: the repository has `v1.0.0`, `v1.1.0` and `v1.6.0`). They are not needed for 1.8.0 to publish. The same is true of 1.5.0 (published by hand from `e2f9aac6c8e0afc8897e647c735f40614892c458`, no tag or GitHub release yet). They matter because [ROLLBACK.md](./ROLLBACK.md) and UPGRADE.md send users to GitHub releases to get an older version, and a release is where the source maps for 1.4.0 are kept. Do this **before** the 1.8.0 steps above, or skip it and accept that 1.4.0 has no release.

You need the commit that the uploaded 1.4.0 `.vsix` was built from. If you built from the merge commit of the 1.4.0 release pull request, that is `8fcc2341551129641334b4c6325a1ff2139db0d8` (its `extension/package.json` says 1.4.0). If you built from a later commit, use that one; the Marketplace does not record it. If you still have the exact `.vsix` you uploaded, attach that file. Do not rebuild it now: a rebuilt file has a different hash than the published one.

```bash
git fetch origin --tags
SHA_140=8fcc2341551129641334b4c6325a1ff2139db0d8     # change if you built from another commit
git show "$SHA_140":extension/package.json | grep '"version"'   # must say 1.4.0
git tag -a v1.4.0 -m "v1.4.0" "$SHA_140"
git push origin v1.4.0
mkdir -p artifacts
git show "$SHA_140":extension/CHANGELOG.md > /tmp/changelog-1.4.0.md
CHANGELOG_PATH=/tmp/changelog-1.4.0.md bash tools/release-notes.sh v1.4.0 > artifacts/RELEASE_NOTES_v1.4.0.md
wc -l < artifacts/RELEASE_NOTES_v1.4.0.md                                  # about 83 lines
grep -c 'Upgrading from 1.3.0 to 1.4.0' artifacts/RELEASE_NOTES_v1.4.0.md  # must print 1
# ---- Version A: with the VSIX you uploaded (if you do not have it, stop here and use version B below) ----
VSIX_140=/full/path/to/the-vsix-you-uploaded/filemaker-data-api-tools-1.4.0.vsix   # the exact file you uploaded
shasum -a 256 "$VSIX_140"                                                           # note the hash
gh release create v1.4.0 --repo SureForgeTech/filemaker-data-api-for-vs-code --verify-tag \
  --title v1.4.0 --notes-file artifacts/RELEASE_NOTES_v1.4.0.md --latest=false \
  "$VSIX_140"
```

**Version B: without the VSIX** (you no longer have the uploaded file; run this instead of version A, not as well):

```bash
gh release create v1.4.0 --repo SureForgeTech/filemaker-data-api-for-vs-code --verify-tag \
  --title v1.4.0 --notes-file artifacts/RELEASE_NOTES_v1.4.0.md --latest=false
```

Pushing the tag starts a `CI` run; **Reject** its `marketplace` deployment exactly as in step 3.4. Run only one of the two `gh release create` commands. Source maps for 1.4.0 are lost unless you kept the tarball; say so in the release notes if so.

## If something is wrong

See [ROLLBACK.md](./ROLLBACK.md): ship a patch release first; unpublishing hides the whole extension and is the last resort. A version that has been published cannot be reused, so a fix is `1.4.1`.
