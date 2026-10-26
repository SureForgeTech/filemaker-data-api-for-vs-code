# Job aid: set up token-free publishing with Microsoft Entra ID

**Why:** Azure DevOps personal access tokens (what `vsce` used) stop working on **1 December 2026**. Microsoft is retiring the "global" kind (created with **All accessible organizations**), and recommends Microsoft Entra ID instead ([announcement](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/), [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)). This setup lets GitHub publish to the Marketplace with a short-lived sign-in instead, so there is no token to create, store or renew. The release pipeline no longer reads `VSCE_PAT`; if a `VSCE_PAT` secret still exists on the `marketplace` environment or the repository, delete it.
**Time:** about 20 minutes, once. **Cost:** free (managed identities and federated credentials have no charge).
**Checked against current docs on 2026-10-18.** Where a step could not be confirmed from Microsoft's documentation it is marked **(unconfirmed)**; the first real publish is the test.

If anything here fails, you can still release by uploading the `.vsix` by hand at <https://marketplace.visualstudio.com/manage>; the steps (and the GitHub release command) are in [RELEASE.md](./RELEASE.md#manual-publish-fallback). Nothing in this setup blocks that, and it keeps working after 1 December 2026.

## What you need

- The Microsoft account that owns the `SureForgeTech` publisher.
- An Azure account with a subscription (the free account is enough): <https://azure.microsoft.com/free>. You need it only to create the identity; the identity itself should need no Azure permissions. Microsoft's Azure Pipelines instructions mention giving it the Reader role, but our login uses `allow-no-subscriptions`, which skips that. If the sign-in step later says it found no subscription, give the identity the Reader role on your subscription and try again.
- Admin on the GitHub repo (you are).

## Part 1: create the identity in Azure (5 minutes)

1. Go to <https://portal.azure.com> and sign in.
2. In the top search box type **Managed Identities** and open it, then click **+ Create**.
3. Choose your subscription, create or pick a resource group (for example `publishing`), pick any region, and name it `vsce-publisher`. Click **Review + create**, then **Create**.
4. When it finishes click **Go to resource**.

## Part 2: let only the `marketplace` environment use it (5 minutes)

This repository's GitHub sign-in claim uses the permanent-ID format (it contains numeric ids), so the portal's built-in "Environment" shortcut would create a credential that does not match, and that fails silently later. Use the **Other issuer** scenario with the exact values below.

In the identity's page:

1. In the left menu open **Settings > Federated credentials**, then **+ Add credential**.
2. **Federated credential scenario:** **Other issuer**.
3. Fill in:
   - **Issuer:** `https://token.actions.githubusercontent.com`
   - **Type:** Explicit subject identifier
   - **Subject identifier:** `repo:SureForgeTech@343994947/filemaker-data-api-for-vs-code@1171265957:environment:marketplace`
   - **Name:** `github-marketplace`
   - **Audience:** `api://AzureADTokenExchange`
4. Click **Add**.

(Microsoft's page for this: <https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity>. The ids come from this repository's GitHub setting, read on 2026-10-18; they change only if the repository is deleted and recreated. The environment form of the subject is inferred from GitHub's documented branch form.)

If the first publish fails at sign-in, the run log shows the subject GitHub sent. Paste that value into the credential's Subject identifier field, or open an issue if it differs in a way you cannot explain.

## Part 3: tell GitHub which identity to use (3 minutes)

1. In Azure, on the identity's **Overview** page, copy the **Client ID**. Open **Properties** and copy the **Tenant ID**. (These are identifiers, not secrets.)
2. Open <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/settings/environments> and click **marketplace**.
3. Under **Environment variables** click **Add variable**. Add `AZURE_CLIENT_ID` (the Client ID) and `AZURE_TENANT_ID` (the Tenant ID).

Terminal alternative:

```bash
gh variable set AZURE_CLIENT_ID --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code --body "<client id>"
gh variable set AZURE_TENANT_ID --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code --body "<tenant id>"
```

## Part 4: get the identity's Azure DevOps id (10 minutes)

The Marketplace identifies the identity by an id that only the identity itself can read. The helper workflow `entra-identity-id.yml` prints it. The `marketplace` environment normally accepts only `v*` tags, so allow the `main` branch for the length of this step. Do Parts 1 to 3 first. You need repository admin rights and the GitHub CLI signed in (`gh auth login`).

1. Add a temporary branch rule to the environment:
   ```bash
   gh api -X POST repos/SureForgeTech/filemaker-data-api-for-vs-code/environments/marketplace/deployment-branch-policies -f name=main -f type=branch
   ```
   The response includes an `id`. Write it down.
2. Start the helper from `main`: `gh workflow run entra-identity-id.yml --repo SureForgeTech/filemaker-data-api-for-vs-code --ref main`.
3. Open the run (`gh run list --workflow entra-identity-id.yml`), click **Review deployments**, tick **marketplace**, then **Approve and deploy**.
4. When the run finishes, open the log of the step **Print the Azure DevOps id** and copy the value. It is an identifier, not a secret.
5. Remove the temporary rule so the environment is tags-only again, using the `id` from step 1 (or list them with `gh api repos/SureForgeTech/filemaker-data-api-for-vs-code/environments/marketplace/deployment-branch-policies`):
   ```bash
   gh api -X DELETE repos/SureForgeTech/filemaker-data-api-for-vs-code/environments/marketplace/deployment-branch-policies/<id>
   ```

## Part 5: allow that identity to publish (3 minutes)

1. Open <https://marketplace.visualstudio.com/manage> and click the **SureForgeTech** publisher.
2. Open **Members** and **Add**.
3. Paste the id from Part 4, set the role to **Contributor**, save. **(unconfirmed: the exact button labels; Microsoft names the Contributor role but shows no screenshot for this step.)**

Microsoft's description of this step: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> (the Microsoft Entra ID section).

## Part 6: publish

Push the `v*` tag. In the run, approve the **marketplace** deployment. The `publish` job signs in with the identity and publishes. If it fails at the publish step with an access error, open an issue with the (redacted) message. This flow is documented by Microsoft only for Azure Pipelines, and reported working on GitHub Actions by one third-party write-up, not by Microsoft, so a failure here may need a change to the workflow. After **publish**, the run asks for a second **marketplace** approval for **publish-ovsx** (Open VS X): it needs the `OVSX_PAT` secret, which does not exist yet ([#265](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/issues/265)), so the run stops at "OVSX_PAT is not set" and **release** is skipped — that is expected until the token is stored, and the GitHub release is then created by hand ([JOB_AID_MANUAL_RELEASE.md](./JOB_AID_MANUAL_RELEASE.md)). See [RELEASE.md](./RELEASE.md#how-publishing-works).

## Afterwards

- Delete the helper workflow (`.github/workflows/entra-identity-id.yml`) in a pull request once Part 5 is done, and confirm the temporary `main` rule from Part 4 is gone.
- There is no `VSCE_PAT` anywhere and nothing to renew on the Marketplace path. Open VS X is different: it uses the `OVSX_PAT` token, which does need storing and rotating ([SECRETS.md](./SECRETS.md)).

## Pitfalls

- The subject in Part 2 must match exactly (including `marketplace`); a mismatch is accepted when you save and fails silently at sign-in.
- Use a **user-assigned managed identity**, not an "app registration". A third-party report says an app registration signs in but fails at the publish step.
- The id pasted in Part 5 must be the one from Part 4, not the Client ID.
- Do this before 1 December 2026 if you want automatic publishing to keep working.

## Later option

`vsce` 4.0.0 also has a hidden `--oidc` option (GitHub sign-in straight to the Marketplace, no Azure at all). It is not in Microsoft's documentation and the way a publisher turns it on is not documented, so it is not used. If Microsoft documents it, it would replace Parts 1 to 5.
