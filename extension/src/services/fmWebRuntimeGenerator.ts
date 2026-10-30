import { createHash, randomBytes } from 'crypto';
import { access, chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';

import type * as vscode from 'vscode';

import { assertSafeOutputFolder, GENERATED_MARKER, GenerationSkippedError, writeGeneratedFiles } from './generatedFileWriter';
import { migrateLayoutDefinition } from '../fmweb/layoutSchema';
import { renameReplacing } from '../utils/renameReplacing';
import type { Logger } from './logger';
import type { FmWebProjectService } from './fmWebProjectService';

interface TemplateCopySummary {
  created: string[];
  skipped: string[];
  /** Managed files that were refreshed from an older template version. */
  updated: string[];
  /** Managed files left alone because they were edited; the preview may not work until updated. */
  needsManualUpdate: string[];
  outputRoot: string;
}

interface GeneratedLayoutSummary {
  id: string;
  name: string;
  sourcePath: string;
  outputPath: string;
}

/** Values that are safe to write to a `.env` line: no whitespace, quotes or line breaks. */
const SAFE_ENV_VALUE = /^[A-Za-z0-9:/._~%+=@-]+$/;

/**
 * The repository's own quality-gate tooling. A generated FM Web app runs its own tests but does
 * not lint itself, so it needs neither these scripts nor these packages; before this repository
 * grew its own gates, generated apps shipped neither. They are therefore removed from every
 * manifest the generator writes, and nothing else is: the app keeps its `test` script and its
 * runtime dependencies.
 */
export const MONOREPO_ONLY_TOOLING = {
  scripts: ['lint', 'test:coverage'],
  devDependencies: [
    'eslint',
    '@eslint/js',
    '@typescript-eslint/parser',
    '@typescript-eslint/eslint-plugin',
    'eslint-config-prettier',
    'globals'
  ]
} as const;

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * The manifest of a generated app: the template manifest without the repository's own quality-gate
 * tooling. Keys that the template does not have are not added, and the order of the remaining keys
 * is kept, so a generated manifest stays byte-for-byte the one earlier releases shipped.
 */
export function withoutMonorepoTooling(pkg: PackageManifest): PackageManifest {
  const result: PackageManifest = { ...pkg };
  if (pkg.scripts) {
    const scripts = { ...pkg.scripts };
    for (const name of MONOREPO_ONLY_TOOLING.scripts) {
      delete scripts[name];
    }
    result.scripts = scripts;
  }
  if (pkg.devDependencies) {
    const devDependencies = { ...pkg.devDependencies };
    for (const name of MONOREPO_ONLY_TOOLING.devDependencies) {
      delete devDependencies[name];
    }
    result.devDependencies = devDependencies;
  }
  return result;
}

/** Bump together with the `fmweb-managed: runtime template vN` line in the managed files. */
export const RUNTIME_TEMPLATE_VERSION = 7;
const MANAGED_MARKER = /^(?:\/\/|\/\*) fmweb-managed: runtime template v(\d+)/;

/**
 * Files of the runtime template that the extension owns and keeps current in apps that were
 * generated earlier: the bridge client and the code that hands it the address and token. Each
 * value lists SHA-256 hashes (line endings normalised) of the shipped versions that had no
 * version marker, so an unmodified old copy can be recognised and refreshed safely.
 *
 * A hash is of the file as it lies in a GENERATED app, which is not always the template file:
 * the generator rewrites `package.json` (the shared dependency) and `vitest.config.ts` (the
 * shared alias) on the way out. An app generated before a rewrite carries the older form, and an
 * app generated after it carries the rewritten one, so both forms of a rewritten file belong
 * here. The hash of the raw template file in use is appended at runtime, so it does not.
 */
export const MANAGED_TEMPLATE_FILES: Record<string, string[]> = {
  'package.json': ['01f94b699e9d6c9939b2bb1a49028f028c7ba29e2f9f53bd2160318edbecb991', '6d184961fb6759b90115ff94d15dac9455b401917d2d1527b7d3b98531b67ee8', 'c170e5afd10b11e6a02c5914756407fce984f6d925766c0a68077cd0515af9b8'],
  'vitest.config.ts': [
    // The raw template file, which is what an app generated before the shared alias was rewritten
    // carries. The raw file of the template in use is appended at runtime, not listed here.
    'c2bd4b81a42becfbb5fa2fc55aee8c57943590ed9ec79c17082731f78a59b949',
    // The rewritten copy an app generated before the test config gained its coverage block has.
    '64750770206792d2d1373c5de4c2984417c296f345425ba4ab065f4229081f02',
    // The rewritten copy this release makes.
    'bc61824030aa0581801925376a7bfaaf4ead07a33876a7c88eb18764750cd53d'
  ],
  'app/styles.css': ['ed5fdbfd2e42b6e952332bc74a1ddbeefe9d831493d72b567e8832bf98c4c6f8'],
  'app/layouts/[id]/page.tsx': [
    '0da7442c0152dd6bc59d53741a7bca633723afad470e5afb095e73590412b266',
    '645ed91229d76841ea407279e6d0472f9d8af64dd3dcd4313c7aa566789ae814'
  ],
  'lib/bridge-client.ts': ['5498ff7031a1e12b4c74b1d1a5d8c08f286754732f5c26006760f8ea95d58d1f'],
  'lib/runtime-data.ts': ['3e382ec9f700d98c480e30fa714f1fdb322a758b3d71b431ef07624c37b400aa'],
  'lib/runtime-behavior.ts': ['6d5794b937c78c15a1a2f97ab4fec42d88f9a6fb0d366c6d0625c80aad8cef95'],
  'app/layouts/[id]/runtime-layout-client.tsx': [
    'c640219eb6fd4fdd673f0a4e1982545774af0a40a0007ca51caa1f0ebd3de2e0',
    'f1638379856babcb38394bc83b0a77eb46b757f8eab54501b469a93bee447668'
  ]
};

/**
 * SHA-256 hashes (line endings normalised) of every version of each managed file that the
 * extension shipped WITH a version marker, the current one included. A copy that carries an older
 * marker is only refreshed when it matches one of these; otherwise the user edited it (the marker
 * line survives an edit) and it is left alone and reported. When you change a managed file in
 * runtime-next, bump RUNTIME_TEMPLATE_VERSION and ADD the new hash here without removing the old
 * one; the runtime-template test fails until you do.
 */
export const SHIPPED_MARKED_HASHES: Record<string, string[]> = {
  'app/styles.css': ['15d2d57725d731126dc25aa9b303089e38539ff8deb472cbbafb2818c3c5e668', 'bf07315f6023a7a419f8e926ed9f7d7c5351527705bd7acdb6a79cc306575e0c', '6cfbca26c1eefc8430cce0c58533650ef13d173ba46655462b651b0d0797c52a', '12d9335a7c1b4aea281d087e4abfa43e2db3f3a398d99839221b7447926c20e9'],
  'app/layouts/[id]/page.tsx': ['4a7882e3638ccadf65d48b1fa7a16a14b98df4009671453ea82f4ce18159e895', '167da245a60540ea0f64900f31445424f4dbe6c025a525e7314088f4d0b8f3de', 'b1511cd97b2a9578d29c979e1f3cd4d824558af6b6a998019e1f119f607cdec5', 'dcec25cb4a48333db7d9dc07cea9b84008dbbd2de2fe0724b864268c81e261f6', '86c82b206e05ab63cb5568634195287ab8328b8cb26c014b3c0a3f6264110788'],
  'lib/bridge-client.ts': ['e0253ec75ce1dd79cef212a05f12cc4db4570ffb5cc8f36fb3775f9ac72f323e', '4c1b977065ac9689fc4992c7139f685e16f6489240d1f195ebe4044c20e99b07', '7823748b4050231a7a8bfbc781181bab1aea425a5c5c6855b06a5d7f0918d1a9', 'e43af510f1160deb036a789425475d92f757c46caacc43cae613aeae898b2113', '1a2aad8b95024684b8b3949b3d06350b329dd2f5d0b4e07764bb5d88866c02c0', '73c3c93d26a832f8e3b7b603fe17d8745011954ca2bb8a9034609005d2ebbc0e'],
  'lib/runtime-data.ts': ['22cad0412d5a831000a671fc210edde6e7eb6285ea49356981b4e80d9ab0d729', '17ef4bdd043cd5e61fc23bee9516acb66696f4775f53c347048277c32693de3b', 'da5854ee29102d44e966881ccdc2679afd1691d12eee0a1365803b86f0d6ff82', 'd0c19e1992bf77583343490fd7e163e582dcfec03f2deb4d9680cdb6b627e9b8', 'b2afe833d53d11acb2a0e17e8e3b8e9e0c7f6f929d24e0ddc503f7fea6fa1036', '2df2769b31c53c8432ad0ed84b8582933f169095ec3af0c9d3caa5a7ce456861'],
  'lib/runtime-behavior.ts': ['8d74f0dc280c8a42e4e64e1b47a0df0d11f09beba8605808c5263a81a6f3b94d', '84f4d5c3c7c0f01e033d48476e419150ba1ed28fc28542c61f319613f8d59609', 'bac62b9460c693e064c4f0e516d6e2f382c7a22ed21548ae1a3a59e633dca2d1', '74a2c6f22d6d68e83e590c3f9e5d3c3772d0877db9d8d73f308598057ec5bbff', '8b70dafeeeb6444f885b34e67a6b09cce070334bffc2ca787bca60c2bf8f7809', 'd5d55cbf6d9b1c3354c52250a7c2f6225b671d64a7da3d8912ebce4254618468'],
  'app/layouts/[id]/runtime-layout-client.tsx': ['6becf8abb393e1e501f75390540b0fbefec17c9ca77803fc4f9352157a67249e', '12d62d25e10b9a94af9e23f997c0bfc1f522c5d50906d67cc6b13a10de6748e5', '40c2f2e4b688c23049ecd70ae2d707766a079953e09134c3ddfd13e7fea09a5b', 'a0cb143cc37ecc41db012951881277e7bd5cfb413ae257ce5ce7909b40466d42', '8e4ee2d8871914d66669a2b17aa72502be87a08ec021ffc96dd84b8dfdd44a13', '3699982b4cafeee34798a1f389a70236b8fc44d280a06497a720376da8ed561b']
};

/** Known shipped shared sources (including generated package.json). Keep old hashes when updating. */
export const SHIPPED_SHARED_HASHES: Record<string, string[]> = {
  'src/field-order.ts': ['2c1a5d992d4daf838e2d13c43b1939043a4163eb13af4eae0cbddf6ad27ec966', '3b60a97a6b9b023be8d7e3d86d4c7cc0125e3f6bd9bde2db8ca7706b063e6bfa'],
  'src/layout-schema.ts': ['e7f4b45780facf95f8250a74b4e60afd27c5af455ee015e879fa062e69f0d63b', '5f19d99380319c6c1e1352730784559dbb23ba03da792bcdf9fc7118be024129', '1a1f837967649e78baa192dc0d735e026a1349080d7dfe9000e4aa8d8aa044cd'],
  'src/ui-renderer.tsx': ['485d4b2022d64ac21ebcd36c58f57792e36b448a7fec9b9a6a2eeb1373a522ab', 'dea92786b52f47ddbd02a1f0b4f34c73155303a9725e06cbcf2a3ade8301e0c7', '72926b784cc27a5d5046b448797b25b80a30f1af8fe12d70ef2d8061b2746728', '083c1a277145bbe9b08e36f5020322dd95d32766ac6c7ae8730a2e392594f082', 'ce2223340e0dd67a0b74e8fe0604d5cbd7f73011728442df09c8566afbf3780a', '9d1998bddce48ddcb138c3d606a30091db89e8c30d5688ed641bbf91de1fded2', 'd261d2c2e95c8414dfa402f90a3169ee4623c0e5dc0281cef7c393229427f230'],
  'src/field-standards.ts': ['dbd9dcbac9791a895962a977c37a3f3602729f0903c8ccbda05f40fc873421cf', '94b0eadb1666dce9e7f98ae43effde612dbab49cbdccfa80cf819de80dbb7547', '3ff4a3d7ae593c0edc13ccd41007f7a56d9bba620bbebaf26f960068c487ad82', 'afd81a07b641a620894238a0383c1fca55f265b5e0484ebd6d1ab644aa343a5e', 'e5ac70259470aea19e72065ed9150f8802e998a5f01e75231941c6b75aed7bfd'],
  'src/record-edit.ts': ['6f3b044bb3fbbbc00f80ce85761d2c8f02daa874ad62e310c7ba6e5c7b12132c', '8ec99479832ae7f19bd3d34027a014e02db6ebeb2b05d20f29685ab6a04639d3', 'b44afc69a6766e1bbc06ed12f46ad8402075454505eb04a0fb077b71d3e87e51', '7d1308d3c1e015448c4f420ca9549cad84d3b8247b65f16d7f78f7b8376f9c44', 'a19ca01072fa6c0309fcf077c7801f024b307cd4ee918c7cc796a005d44171fb'],
  'src/index.ts': ['a78e69d0c2565173c08ca580ebd1f640e9c6fcecee7cecf58a36ce2a82ad96c2', '06c864f496f814f388ecf810d7ccff61b81ebcb434b45b46ed19a0ccf0fdb201'],
  'package.json': ['304d3c7084ac8c0d59f83461fbdf4cb97feb64f9a19062ed8345e520b637247c']
};

export function normalizedHash(content: Buffer): string {
  return createHash('sha256').update(content.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Whether an existing copy of a managed file may be replaced by the shipped one.
 * - older marker: refreshed only if it is byte-for-byte (line endings aside) a version we shipped
 *   with a marker; an edited copy keeps its marker line, so the marker alone proves nothing;
 * - current or newer marker: nothing to do;
 * - no marker: refreshed only if it is a version we shipped before markers existed.
 * Anything else is the user's and is left alone ('edited').
 */
export function decideManagedRefresh(
  existing: Buffer,
  legacyHashes: string[],
  markedHashes: string[],
  currentVersion: number = RUNTIME_TEMPLATE_VERSION
): 'refresh' | 'current' | 'edited' {
  const firstLine = existing.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  const marker = MANAGED_MARKER.exec(firstLine);
  const hash = normalizedHash(existing);
  if (marker) {
    if (Number(marker[1]) >= currentVersion) {
      return 'current';
    }
    return markedHashes.includes(hash) ? 'refresh' : 'edited';
  }
  return legacyHashes.includes(hash) ? 'refresh' : 'edited';
}

/** Raised when the runtime template is not part of this installation of the extension. */
export class RuntimeTemplateUnavailableError extends Error {
  public constructor() {
    super(
      'The FM Web preview is not available in this installation. It needs the runtime-next and shared packages from the filemaker-data-api-for-vs-code repository, which the Marketplace extension does not include. Open that repository (or run the extension from source) to use the preview.'
    );
    this.name = 'RuntimeTemplateUnavailableError';
  }
}

/**
 * Where the runtime template lives for an extension installed at `extensionRoot`, or undefined when
 * this installation does not carry it (the Marketplace package leaves out runtime-next). The
 * generator and the activation-time context key both use this, so a command is hidden exactly when
 * invoking it would fail with RuntimeTemplateUnavailableError.
 */
export async function resolveRuntimeTemplateRoot(extensionRoot: string): Promise<string | undefined> {
  const candidates = [
    // path-join disposition: the extension folder and the fixed "runtime-next" package name; no input chooses these parts.
    path.join(extensionRoot, '..', 'runtime-next'),
    // path-join disposition: the extension folder and a fixed package name; the folder is only read.
    path.join(extensionRoot, 'runtime-next'),
    // path-join disposition: the extension folder and a fixed template folder name; no input chooses these parts.
    path.join(extensionRoot, 'src', 'runtime-template')
  ];

  for (const candidate of candidates) {
    // path-join disposition: the candidate is one of the three fixed template roots above and "package.json" is a fixed name.
    if (await exists(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  return undefined;
}

/** The context key the preview commands' menu entries depend on. */
export const PREVIEW_AVAILABLE_CONTEXT_KEY = 'filemaker.fmWebPreviewAvailable';

/** Sets the context key from what this installation carries. Returns the value it set. */
export async function publishPreviewAvailability(
  extensionRoot: string,
  setContext: (key: string, value: boolean) => Thenable<unknown> | void
): Promise<boolean> {
  const available = await resolveRuntimeTemplateRoot(extensionRoot).then(
    (root) => root !== undefined,
    () => false
  );
  await setContext(PREVIEW_AVAILABLE_CONTEXT_KEY, available);
  return available;
}

export class FmWebRuntimeGenerator {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fmWebProjectService: FmWebProjectService,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  ) {}

  public async generateRuntimeAppTemplate(): Promise<TemplateCopySummary> {
    this.assertWorkspaceTrusted();

    // Without the template there is nothing that could work: an older built-in fallback app
    // had no bridge client and depended on a `shared` package that only the repository has.
    const templateRoot = await this.resolveTemplateRoot();
    if (!templateRoot) {
      throw new RuntimeTemplateUnavailableError();
    }

    await this.fmWebProjectService.ensureProjectInitialized();

    const outputRoot = this.getGeneratedRuntimeRoot();
    await this.assertSafeFolder(outputRoot);
    await mkdir(outputRoot, { recursive: true });

    const templateFiles = await collectFiles(templateRoot, templateRoot);
    const created: string[] = [];
    const skipped: string[] = [];
    const updated: string[] = [];
    const needsManualUpdate: string[] = [];

    for (const relativePath of templateFiles) {
      const sourcePath = path.join(templateRoot, relativePath);
      const outputPath = path.join(outputRoot, relativePath);
      const managedKey = relativePath.split(path.sep).join('/');
      const sourceContent = await readFile(sourcePath);
      const content = relativePath === 'package.json'
        ? Buffer.from(`${JSON.stringify({
            ...withoutMonorepoTooling(JSON.parse(sourceContent.toString('utf8'))),
            dependencies: {
              ...JSON.parse(sourceContent.toString('utf8')).dependencies,
              '@fmweb/shared': 'file:./shared'
            }
          }, null, 2)}\n`)
        : relativePath === 'vitest.config.ts'
          ? Buffer.from(sourceContent.toString('utf8').replace("'../shared/src/index.ts'", "'./shared/src/index.ts'"))
          : sourceContent;

      // lstat, not access: a link (even a dangling one) is something the user or the repository put
      // there, and a write would follow it to wherever it points. Leave it alone; for a managed
      // file say so, because the preview may then run with a stale or foreign copy.
      await this.assertSafeFolder(path.dirname(outputPath));
      const present = await lstat(outputPath).catch(() => undefined);
      if (present) {
        const legacyHashes = ['package.json', 'vitest.config.ts'].includes(relativePath)
          ? [...(MANAGED_TEMPLATE_FILES[managedKey] ?? []), normalizedHash(sourceContent)]
          : MANAGED_TEMPLATE_FILES[managedKey];
        if (present.isDirectory()) {
          throw new Error(`${relativePath} in the generated runtime is a folder, not a file; remove it and try again.`);
        }
        if (present.isSymbolicLink()) {
          skipped.push(relativePath);
          if (legacyHashes) {
            needsManualUpdate.push(relativePath);
            this.logger.warn('A managed runtime file is a symbolic link; it was not refreshed.', { file: relativePath });
          }
          continue;
        }
        const decision = normalizedHash(content) === normalizedHash(await readFile(outputPath)) ? 'current' : legacyHashes
          ? decideManagedRefresh(await readFile(outputPath), legacyHashes, SHIPPED_MARKED_HASHES[managedKey] ?? [])
          : 'skip';
        if (decision === 'refresh') {
          await this.assertSafeFolder(path.dirname(outputPath));
          await writeManagedFile(outputPath, content);
          updated.push(relativePath);
        } else {
          skipped.push(relativePath);
          if (decision === 'edited') {
            needsManualUpdate.push(relativePath);
            this.logger.warn('A managed runtime file was edited and was not refreshed.', { file: relativePath });
          }
        }
        continue;
      }

      await this.assertSafeFolder(path.dirname(outputPath));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await this.assertSafeFolder(path.dirname(outputPath));
      await writeManagedFile(outputPath, content);
      created.push(relativePath);
    }

    const sharedRoot = path.join(templateRoot, '..', 'shared');
    const sharedOutput = path.join(outputRoot, 'shared');
    // path-join disposition: the shared package folder and the names the template lists; the target is confined by assertSafeOutputFolder.
    const sharedFiles = ['package.json', ...await collectFiles(path.join(sharedRoot, 'src'), path.join(sharedRoot, 'src')).then((files) => files.map((file) => path.join('src', file)))];
    for (const file of sharedFiles) {
      const target = path.join(sharedOutput, file);
      const reported = path.join('shared', file);
      let content = await readFile(path.join(sharedRoot, file));
      if (file === 'package.json') {
        const pkg = JSON.parse(content.toString('utf8'));
        // Next transpiles this source package; no prebuilt/stale shared dist is copied.
        // The repository's own lint tooling is not copied either: a generated app does not lint itself.
        content = Buffer.from(`${JSON.stringify({
          ...withoutMonorepoTooling(pkg),
          main: 'src/index.ts',
          types: 'src/index.ts',
          scripts: {}
        }, null, 2)}\n`);
      }
      await this.assertSafeFolder(path.dirname(target));
      const present = await lstat(target).catch(() => undefined);
      if (present) {
        const existingHash = present.isFile() ? normalizedHash(await readFile(target)) : undefined;
        const current = existingHash === normalizedHash(content);
        if (!current && existingHash && SHIPPED_SHARED_HASHES[file.split(path.sep).join('/')]?.includes(existingHash)) {
          await writeManagedFile(target, content);
          updated.push(reported);
          continue;
        }
        skipped.push(reported);
        if (!current) {
          needsManualUpdate.push(reported);
          this.logger.warn('A generated shared file was edited and was not refreshed.', { file: reported });
        }
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await this.assertSafeFolder(path.dirname(target));
        await writeManagedFile(target, content);
        created.push(reported);
      }
    }

    return {
      created,
      skipped,
      updated,
      needsManualUpdate,
      outputRoot
    };
  }

  public async listLayoutDefinitions(): Promise<Array<{ id: string; name: string; filePath: string }>> {
    this.assertWorkspaceTrusted();
    await this.fmWebProjectService.ensureProjectInitialized();

    const layoutsDir = this.fmWebProjectService.getLayoutsDirPath();
    const entries = await readdir(layoutsDir);
    const layouts: Array<{ id: string; name: string; filePath: string }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.layout.json')) {
        continue;
      }

      const filePath = path.join(layoutsDir, entry);
      try {
        const raw = await readFile(filePath, 'utf8');
        const layout = migrateLayoutDefinition(JSON.parse(raw));
        layouts.push({
          id: layout.id,
          name: layout.name,
          filePath
        });
      } catch (error) {
        this.logger.warn('Skipping invalid layout definition while generating runtime artifacts.', {
          filePath,
          error
        });
      }
    }

    return layouts.sort((left, right) => left.name.localeCompare(right.name));
  }

  public async generateLayoutPage(layoutId?: string): Promise<GeneratedLayoutSummary> {
    this.assertWorkspaceTrusted();
    await this.fmWebProjectService.ensureProjectInitialized();

    const layouts = await this.listLayoutDefinitions();
    if (layouts.length === 0) {
      throw new Error('No layouts found. Create and save a layout first.');
    }

    const selected = layoutId ? layouts.find((entry) => entry.id === layoutId) : layouts[0];
    if (!selected) {
      throw new Error(`Layout with id "${layoutId}" was not found.`);
    }

    const raw = await readFile(selected.filePath, 'utf8');
    const parsed = migrateLayoutDefinition(JSON.parse(raw));
    const layout = await this.fmWebProjectService.prepareLayout?.(parsed) ?? parsed;
    const outputDir = this.getGeneratedLayoutsRoot();
    const outputPath = path.join(outputDir, `${layout.id}.layout.json`);

    const skipped = await writeGeneratedFiles([{ path: outputPath, content: `${JSON.stringify({ $comment: GENERATED_MARKER, ...layout }, null, 2)}\n` }], this.fmWebProjectService.getWorkspaceRoot?.() ?? this.fmWebProjectService.getProjectRoot());
    if (skipped.length) throw new GenerationSkippedError(outputPath);

    return {
      id: layout.id,
      name: layout.name,
      sourcePath: selected.filePath,
      outputPath
    };
  }

  /**
   * Writes the bridge address and its per-session token into the generated runtime's
   * `.env.local` so the preview app can reach the bridge (it refuses requests without the
   * token). The file holds a secret: it is created owner-only and a `.gitignore` next to it
   * keeps it out of git. Nothing here logs the token.
   */
  public async writeBridgeEnv(baseUrl: string, token?: string): Promise<string> {
    this.assertWorkspaceTrusted();
    if (!SAFE_ENV_VALUE.test(baseUrl) || (token !== undefined && !SAFE_ENV_VALUE.test(token))) {
      throw new Error('The bridge address or token contains characters that cannot be written to an env file.');
    }

    const runtimeRoot = this.getGeneratedRuntimeRoot();
    await this.assertSafeFolder(runtimeRoot);
    await mkdir(runtimeRoot, { recursive: true });
    await this.ensureRuntimeGitignore(runtimeRoot);
    const envPath = path.join(runtimeRoot, '.env.local');

    const managed: Record<string, string | undefined> = {
      NEXT_PUBLIC_FMWEB_BRIDGE_URL: baseUrl,
      NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN: token
    };

    await refuseSymlink(envPath);
    const existing = (await exists(envPath)) ? await readFile(envPath, 'utf8') : '';
    const kept = existing
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !Object.keys(managed).some((key) => line.startsWith(`${key}=`)));
    const lines = [
      ...kept,
      ...Object.entries(managed)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`)
    ];

    await writeOwnerOnlyFile(envPath, `${lines.join('\n')}\n`);
    return envPath;
  }

  private async ensureRuntimeGitignore(runtimeRoot: string): Promise<void> {
    // path-join disposition: the generated runtime folder and a fixed ".gitignore" name; the folder is confined by assertSafeOutputFolder.
    const gitignorePath = path.join(runtimeRoot, '.gitignore');
    const required = ['.env.local', '.env*.local', 'node_modules', '.next'];
    const current = (await exists(gitignorePath)) ? await readFile(gitignorePath, 'utf8') : '';
    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const missing = required.filter((line) => !present.has(line));
    if (missing.length === 0) {
      return;
    }

    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await refuseSymlink(gitignorePath);
    await writeFile(gitignorePath, `${current}${prefix}${missing.join('\n')}\n`, 'utf8');
  }

  private async assertSafeFolder(directory: string): Promise<void> {
    await assertSafeOutputFolder(directory, this.fmWebProjectService.getWorkspaceRoot?.() ?? this.fmWebProjectService.getProjectRoot());
  }

  public getGeneratedRuntimeRoot(): string {
    return path.join(this.fmWebProjectService.getGeneratedDirPath(), 'runtime-next');
  }

  public getGeneratedLayoutsRoot(): string {
    return path.join(this.fmWebProjectService.getGeneratedDirPath(), 'layouts');
  }

  private resolveTemplateRoot(): Promise<string | undefined> {
    return resolveRuntimeTemplateRoot(this.context.extensionUri.fsPath);
  }

  private assertWorkspaceTrusted(): void {
    if (!this.fmWebProjectService.isWorkspaceTrusted()) {
      throw new Error('Workspace trust is required for FM Web runtime generation.');
    }
  }
}

async function collectFiles(rootDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    // Never copy local env files (they can hold a bridge token) or build output.
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.vite' || entry.name.startsWith('.env')) {
      continue;
    }
    // Coverage output of the repository's own gates: a report of a run that has nothing to do
    // with the app, and it changes with every run.
    if (entry.isDirectory() && entry.name === 'coverage') {
      continue;
    }
    // The lint configuration of the repository: a generated app does not lint itself, and the
    // file names packages the app does not have.
    if (entry.isFile() && entry.name === 'eslint.config.mjs') {
      continue;
    }

    // path-join disposition: the folder being listed and the name the listing gives; a file name cannot climb out of its folder.
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(rootDir, fullPath);
      result.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    result.push(path.relative(rootDir, fullPath));
  }

  return result.sort((left, right) => left.localeCompare(right));
}

/**
 * The generated folder can arrive with a repository, so a link planted at a file we are about to
 * write could redirect the write (and the token in it) elsewhere. Refuse a link at the target.
 */
async function refuseSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`${path.basename(target)} in the generated runtime is a symbolic link; remove it and try again.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Writes a generated file so that a link planted at the target cannot redirect the write: the content
 * goes to a new temporary file in the same folder and is renamed over the target. `rename` replaces
 * the directory entry (a symbolic link is replaced, never followed), so there is no moment between a
 * check and the write at which a link can take effect; the result is checked afterwards. A hard link
 * is not written through either: the other name keeps the old content. A folder at the target is
 * reported in plain words instead of as a raw EISDIR.
 */
export async function writeManagedFile(target: string, content: Buffer | string): Promise<void> {
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isDirectory()) {
    throw new Error(`${path.basename(target)} in the generated runtime is a folder, not a file; remove it and try again.`);
  }
  // path-join disposition: the folder of the already confined target and a random temporary name; the rename replaces the target.
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    // The replacement keeps the permission bits of the file it replaces (an executable stays one, a
    // file the user made owner-only stays owner-only); a new file is owner-only.
    if (existing?.isFile()) {
      await chmod(temporary, existing.mode & 0o777).catch(() => undefined);
    }
    await renameReplacing(temporary, target);
  } catch (error) {
    // Also reached when the write itself failed part way (disk full): never leave the .tmp behind.
    await rm(temporary, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EISDIR' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      throw new Error(`${path.basename(target)} in the generated runtime is a folder, not a file; remove it and try again.`, { cause: error });
    }
    throw error;
  }
  const written = await lstat(target);
  if (!written.isFile()) {
    throw new Error(`${path.basename(target)} in the generated runtime could not be written as a regular file; remove it and try again.`);
  }
}

/** Writes via a new owner-only temporary file and renames it over the target (never follows a link). */
async function writeOwnerOnlyFile(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await renameReplacing(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
