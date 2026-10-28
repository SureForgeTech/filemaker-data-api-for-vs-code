import { createHash } from 'crypto';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { assertOwnerOnly, ensureOwnerOnlyDirectory } from './discovery';

/** The folder (inside the extension's global storage) that holds discovery files. */
export function discoveryDirectory(globalStoragePath: string): string {
  // path-join disposition: "ai-mcp" is a compile-time constant under the extension's global storage folder, so no input can change the path.
  return join(globalStoragePath, 'ai-mcp');
}

/**
 * Ready-to-paste MCP client configuration (Claude Code `.mcp.json` or `claude mcp add-json`,
 * Cursor `mcp.json`). It names the bundled shim, the discovery folder and the window to use.
 * It contains no token: the shim reads that from the discovery file.
 */
export function buildMcpConfig(args: { shimPath: string; discoveryDir: string; workspaceFolder?: string }): {
  mcpServers: { filemaker: { command: string; args: string[] } };
} {
  return {
    mcpServers: {
      filemaker: {
        command: 'node',
        args: [
          args.shimPath,
          '--dir',
          args.discoveryDir,
          ...(args.workspaceFolder ? ['--workspace', args.workspaceFolder] : [])
        ]
      }
    }
  };
}

/** A stable place for the shim, so a client configuration survives extension updates. */
export function installedShimPath(globalStoragePath: string): string {
  // path-join disposition: "ai-mcp-shim" and "aiMcpShim.js" are compile-time constants under the extension's global storage folder, so no input can change the path.
  return join(globalStoragePath, 'ai-mcp-shim', 'aiMcpShim.js');
}

/**
 * Copies the shim from the extension folder (whose name changes with every version) to a
 * stable path in the extension's storage. The folder must be owner-only (created 0700, not a
 * link, owned by this user); the copy is written to a new 0700 file, renamed into place, and
 * read back: it must be a regular owner-only file with the same SHA-256 as the source.
 * Returns the stable path, or the original path (stable: false) if anything fails, so a
 * configuration still works until the next update.
 */
export async function installShim(
  extensionShimPath: string,
  globalStoragePath: string,
  /** For tests: replaces the file reader, to check that the copy is verified. */
  read: typeof readFile = readFile
): Promise<{ path: string; stable: boolean }> {
  const target = installedShimPath(globalStoragePath);
  const temporary = `${target}.${process.pid}.tmp`;
  let renamed = false;
  try {
    await ensureOwnerOnlyDirectory(dirname(target));
    const content = await read(extensionShimPath);
    const expected = createHash('sha256').update(content).digest('hex');
    await writeFile(temporary, content, { flag: 'wx', mode: 0o700 });
    await rename(temporary, target);
    renamed = true;
    await assertOwnerOnly(target, 'file');
    const written = createHash('sha256').update(await read(target)).digest('hex');
    if (written !== expected) {
      throw new Error('The copied shim does not match the original.');
    }
    return { path: target, stable: true };
  } catch {
    await rm(temporary, { force: true });
    if (renamed) {
      await rm(target, { force: true }); // a copy that failed verification is not left to be used
    }
    return { path: extensionShimPath, stable: false };
  }
}
