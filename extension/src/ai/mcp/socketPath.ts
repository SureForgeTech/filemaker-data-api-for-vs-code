import { createHash, randomBytes } from 'crypto';
import net from 'net';
import { lstat, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';

import { ensureOwnerOnlyDirectory } from './discovery';

/** macOS limits a Unix socket path to 104 bytes including the terminator; stay well under. */
export const MAX_SOCKET_PATH_BYTES = 103;

export interface Endpoint {
  /** Unix socket path or Windows pipe name. */
  path: string;
  /** Folder to remove on stop (Unix), if this call created the socket in it. */
  isPipe: boolean;
}

/** `fmai-<uid>-<8 hex of the storage path>`. */
export function socketFolderName(uid: number, scope: string | undefined): string {
  return `fmai-${uid}-${createHash('sha256').update(scope ?? '').digest('hex').slice(0, 8)}`;
}

/**
 * Where to listen. Windows: an unguessable named pipe (Node cannot promise a user-only ACL
 * on it, so the token in the hello message is the control). Unix: a socket in a folder that
 * is created 0700 and checked (owner, mode, not a link), with a short path.
 *
 * `baseDirectory` is for tests; by default `$XDG_RUNTIME_DIR` (already 0700 on Linux) or
 * the temp folder.
 */
export async function createEndpoint(
  options: {
    platform?: NodeJS.Platform;
    baseDirectory?: string;
    scope?: string;
    /** Called for each candidate folder that was rejected (not owned by you, a link, not writable...), so the caller can log why. */
    onSkipped?: (candidate: { variable: string; reason: string }) => void;
  } = {}
): Promise<Endpoint> {
  const platform = options.platform ?? process.platform;
  const id = randomBytes(16).toString('hex');
  if (platform === 'win32') {
    return { path: `\\\\.\\pipe\\fm-ai-${id}`, isPipe: true };
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  // Where to put the socket folder, best first. An empty or relative XDG_RUNTIME_DIR (or
  // TMPDIR) is skipped so the path is always absolute. An explicit base directory is used as
  // given; the environment's folders fall back to the next one if they cannot be used (for
  // example an XDG_RUNTIME_DIR that does not exist or is not ours).
  const explicit = options.baseDirectory !== undefined;
  const candidates = (
    explicit
      ? [{ base: options.baseDirectory, variable: 'the base folder' }]
      : [
          { base: process.env.XDG_RUNTIME_DIR, variable: 'XDG_RUNTIME_DIR' },
          { base: tmpdir(), variable: 'TMPDIR' }
        ]
  ).filter((candidate): candidate is { base: string; variable: string } => typeof candidate.base === 'string' && isAbsolute(candidate.base));
  // VS Code, Cursor and Insiders share the temp folder but each has its own storage: the
  // folder carries a short hash of the storage path, so one product never sees another's sockets.
  const folder = socketFolderName(uid, options.scope);
  let directory: string | undefined;
  let chosenVariable = 'TMPDIR';
  const failures: string[] = [];
  for (const { base, variable } of candidates) {
    try {
      // path-join disposition: the folder name is fmai-<uid>-<8 hex>, built by socketFolderName(), so it has no separator and no ".." segment; the folder is created 0700 and checked by ensureOwnerOnlyDirectory.
      await ensureOwnerOnlyDirectory(join(base, folder));
      // path-join disposition: the same generated folder name (fmai-<uid>-<8 hex>) is joined to the absolute base folder, so the result cannot climb out of it.
      directory = join(base, folder);
      chosenVariable = variable;
      break;
    } catch (error) {
      // Not silent: a rejected folder is reported, and the final error names every one that was tried.
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${variable}: ${reason}`);
      options.onSkipped?.({ variable, reason });
    }
  }
  if (!directory) {
    throw new Error(`No usable folder for the AI server socket. ${failures.length > 0 ? failures.join(' ') : 'XDG_RUNTIME_DIR and TMPDIR are empty or not absolute paths.'}`);
  }
  // path-join disposition: the file name is 12 hex characters of a random id with the fixed ".sock" suffix, so it has no separator and no ".." segment.
  const path = join(directory, `${id.slice(0, 12)}.sock`);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`The socket path would be ${Buffer.byteLength(path)} bytes, over the ${MAX_SOCKET_PATH_BYTES} byte limit. Set ${chosenVariable} to a shorter folder.`);
  }
  return { path, isPipe: false };
}

const SOCKET_MIN_AGE_MS = 30_000;

/**
 * Asks the socket itself. 'dead': nothing listens (connection refused, or the file is gone).
 * 'alive': something accepted the connection. 'unknown': anything else (timeout, other errors).
 */
export function probeSocket(path: string, timeoutMs = 1000): Promise<'dead' | 'alive' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const done = (result: 'dead' | 'alive' | 'unknown'): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done('unknown'), timeoutMs);
    socket.once('connect', () => done('alive'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'dead' : 'unknown'));
  });
}

/**
 * Removes sockets left in our socket folder by a process that died. A socket is removed only
 * if: it is a socket owned by this user; no discovery file that is still in use names it; it is
 * older than 30 seconds; and connecting to it is refused (nothing is listening). The age rule covers two windows starting at the same moment:
 * the other window's socket exists a moment before its discovery file is written.
 * Returns the paths removed.
 */
export async function removeStaleSockets(
  socketDirectory: string,
  inUse: ReadonlySet<string>,
  now: number = Date.now(),
  minAgeMs: number = SOCKET_MIN_AGE_MS
): Promise<string[]> {
  const removed: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let names: string[];
  try {
    names = await readdir(socketDirectory);
  } catch {
    return removed;
  }

  for (const name of names.filter((entry) => /^[0-9a-f]{12}\.sock$/.test(entry))) {
    // path-join disposition: the name is filtered by ^[0-9a-f]{12}\.sock$ before the join, so it has no separator and no ".." segment; the file must also be a socket owned by this user.
    const path = join(socketDirectory, name);
    try {
      const stats = await lstat(path);
      if (!stats.isSocket() || (uid !== undefined && stats.uid !== uid) || inUse.has(path)) {
        continue;
      }
      if (now - stats.mtimeMs < minAgeMs) {
        continue;
      }
      // Never delete a socket something is listening on, whoever it belongs to.
      if ((await probeSocket(path)) !== 'dead') {
        continue;
      }
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      // Gone already, or not ours to touch.
    }
  }
  return removed;
}
