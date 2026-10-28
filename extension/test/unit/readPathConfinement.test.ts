import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { discoveryFileName, isExpectedSocketPath } from '../../src/ai/mcp/discovery';
import { socketFolderName } from '../../src/ai/mcp/socketPath';
import { PathConfinementError, validateConfiguredPath } from '../../src/utils/pathConfinement';

/**
 * Read-side confinement: every path the extension reads comes from a name the extension makes
 * itself (the socket folder, the socket file, the discovery file) or from a path the user
 * configured. A name the extension makes must not be able to carry a separator or a ".."
 * segment, and a configured path must be refused when it climbs out of the workspace. These
 * tests prove the facts the "path-join disposition" comments rest on.
 */

/** The user id the socket folder name carries (0 on Windows, which has no user ids). */
const uid = process.getuid?.() ?? 0;

/** An absolute, canonical base folder: resolve() of it is itself, on every platform. */
const base = join(resolve('.'), 'fm-read-confinement');

/** The Unix socket path the extension creates: <base>/fmai-<uid>-<8 hex>/<12 hex>.sock. */
const expectedSocketPath = (owner = uid, scope = 'storage-a'): string =>
  join(base, socketFolderName(owner, scope), 'abcdef012345.sock');

describe('read path confinement: the socket paths the extension reads', () => {
  it('accepts the Windows named pipe the extension creates, on every platform', () => {
    expect(isExpectedSocketPath('\\\\.\\pipe\\fm-ai-' + 'a'.repeat(32), uid)).toBe(true);
  });

  it('accepts only the socket path shape the extension creates', () => {
    const folder = socketFolderName(uid, 'storage-a');

    // The base is canonical, so every check below is about the socket path itself.
    expect(resolve(base)).toBe(base);
    expect(isExpectedSocketPath(expectedSocketPath(), uid)).toBe(true);
    // The folder of another user.
    expect(isExpectedSocketPath(expectedSocketPath(uid + 1), uid)).toBe(false);
    // A folder name that is not fmai-<uid>-<8 hex>.
    expect(isExpectedSocketPath(join(base, 'fmai-other', 'abcdef012345.sock'), uid)).toBe(false);
    // A file name that is not <12 hex>.sock.
    expect(isExpectedSocketPath(join(base, folder, 'abcdef012345.sockx'), uid)).toBe(false);
    expect(isExpectedSocketPath(join(base, folder, 'ABCDEF012345.sock'), uid)).toBe(false);
  });

  it('refuses a socket path that climbs out of its folder with a ".." segment', () => {
    const folder = socketFolderName(uid, 'storage-a');
    const climbing = `${base}/${folder}/../${folder}/abcdef012345.sock`;
    const outside = `${base}/${folder}/../../etc/abcdef012345.sock`;
    const doubled = `${base}//${folder}/abcdef012345.sock`;

    // The folder and the file name are right: only the canonical-path check can refuse it.
    expect(isExpectedSocketPath(climbing, uid)).toBe(false);
    // A path that leaves the socket folder altogether.
    expect(isExpectedSocketPath(outside, uid)).toBe(false);
    // A doubled separator is not a canonical path either.
    expect(isExpectedSocketPath(doubled, uid)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('read path confinement on a POSIX host', () => {
  it('accepts the Unix socket path, and refuses the same path with a ".." segment', () => {
    const folder = socketFolderName(uid, 'storage-a');
    const socket = `/tmp/${folder}/abcdef012345.sock`;
    const climbing = `/tmp/${folder}/../${folder}/abcdef012345.sock`;

    expect(isExpectedSocketPath(socket, uid)).toBe(true);
    expect(isExpectedSocketPath(climbing, uid)).toBe(false);
  });
});

describe('read path confinement: the names the extension builds', () => {
  it('keeps a hostile scope inside the socket folder name', () => {
    const hostile = socketFolderName(uid, '../../etc');

    expect(hostile).toMatch(/^fmai-\d+-[0-9a-f]{8}$/);
    expect(hostile).not.toContain('/');
    expect(hostile).not.toContain('\\');
    expect(hostile).not.toContain('..');
    // The scope is hashed into the name, not spelled out in it.
    expect(hostile).not.toBe(socketFolderName(uid, '/code/storage'));
  });

  it('names the discovery file with 16 hex characters, whatever the folders are', () => {
    const folders = ['/work/alpha', '../../etc'];
    const name = discoveryFileName(folders, 4242);

    expect(name).toMatch(/^[0-9a-f]{16}\.json$/);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
    // The same window always gets the same file name.
    expect(discoveryFileName(folders, 4242)).toBe(name);
  });

  it('refuses a configured path that climbs out, with a PathConfinementError', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(() => validateConfiguredPath('../evil', platform)).toThrow(PathConfinementError);
      expect(() => validateConfiguredPath('docs/../../evil', platform)).toThrow(/\.\./);
    }
  });
});
