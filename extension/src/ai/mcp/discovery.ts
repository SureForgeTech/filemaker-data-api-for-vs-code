import { createHash } from 'crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve, win32 } from 'path';

import { isProcessAlive, getProcessStartTime } from './processInfo';

/**
 * Discovery files let the shim find the extension host that runs the AI server. One file per
 * VS Code window, in the extension's global storage (outside every workspace), mode 0600,
 * deleted when the server stops. The file holds the token, so the shim checks that the file
 * and its folder belong to the current user and are not readable by others (on Unix), and
 * that the process named in the file is alive and is the same run (pid AND start time).
 */
export const DISCOVERY_VERSION = 1;

export interface DiscoveryRecord {
  version: typeof DISCOVERY_VERSION;
  /** Unix socket path, or Windows named pipe. */
  socketPath: string;
  pid: number;
  startTime: string;
  token: string;
  workspaceFolders: string[];
  label: string;
  created: string;
}

export function parseDiscovery(text: string): DiscoveryRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<DiscoveryRecord>;
    if (
      value &&
      value.version === DISCOVERY_VERSION &&
      typeof value.socketPath === 'string' &&
      value.socketPath.length > 0 &&
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.startTime === 'string' &&
      value.startTime.length > 0 &&
      typeof value.token === 'string' &&
      /^[0-9a-f]{64}$/.test(value.token) &&
      Array.isArray(value.workspaceFolders) &&
      value.workspaceFolders.every((folder) => typeof folder === 'string') &&
      typeof value.label === 'string' &&
      typeof value.created === 'string'
    ) {
      return value as DiscoveryRecord;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

/** A file name for one window: stable for the same folders and process. */
export function discoveryFileName(workspaceFolders: readonly string[], pid: number): string {
  const digest = createHash('sha256').update(JSON.stringify([workspaceFolders, pid])).digest('hex');
  return `${digest.slice(0, 16)}.json`;
}

/** Text that came from a file or a command line, made safe to print: only printable ASCII is kept. */
export function safeText(value: string, max = 200): string {
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

const UNIX_SOCKET_NAME = /^[0-9a-f]{12}\.sock$/;
const WINDOWS_PIPE = /^\\\\\.\\pipe\\fm-ai-[0-9a-f]{32}$/;

/**
 * Only the sockets this extension creates are acceptable: `<folder>/fmai-<uid>-<8 hex>/<12 hex>.sock`
 * on Unix, `\\.\pipe\fm-ai-<32 hex>` on Windows. A discovery file that names anything else is
 * not trusted (the folder itself is checked on disk by the shim).
 */
export function isExpectedSocketPath(path: string, uid: number | undefined = currentUid()): boolean {
  if (WINDOWS_PIPE.test(path)) {
    return true;
  }
  const folder = /^fmai-(\d+)-[0-9a-f]{8}$/.exec(basename(dirname(path)));
  // path-join disposition: resolve(path) === path is the canonical-path check itself: a path with a ".." segment or a doubled separator is not equal to its own resolved form, so it is refused and no file is read here.
  return UNIX_SOCKET_NAME.test(basename(path)) && folder !== null && folder[1] === String(uid ?? 0) && resolve(path) === path;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * On Unix: the path must not be a symbolic link, must be owned by this user and must not be
 * accessible by group or others. On Windows there is no check; the token is the control.
 */
export async function assertOwnerOnly(path: string, kind: 'directory' | 'file', uid: number | undefined = currentUid()): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link.`);
  }
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`${path} is not a ${kind}.`);
  }
  if (uid !== undefined) {
    if (stats.uid !== uid) {
      throw new Error(`${path} is not owned by the current user.`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`${path} is accessible by other users (mode ${(stats.mode & 0o777).toString(8)}).`);
    }
  }
}

/** Creates the folder with mode 0700 (or checks an existing one) and refuses anything unsafe. */
export async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await assertOwnerOnly(path, 'directory');
}

/** Writes the record by creating a new 0600 file and renaming it into place. */
export async function writeDiscovery(directory: string, fileName: string, record: DiscoveryRecord): Promise<string> {
  await ensureOwnerOnlyDirectory(directory);
  // path-join disposition: the file name comes from discoveryFileName() (16 hex characters of a SHA-256 digest), so it has no separator and no ".." segment; the folder is owner-only and was just checked.
  const target = join(directory, fileName);
  // path-join disposition: the temporary name is that same file name with a dot and the process id around it, so it has no separator and no ".." segment either.
  const temporary = join(directory, `.${fileName}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}

export async function removeDiscovery(path: string): Promise<void> {
  await rm(path, { force: true });
}

export interface LiveWindow {
  file: string;
  record: DiscoveryRecord;
}

export interface Liveness {
  alive(pid: number): boolean;
  startTime(pid: number): Promise<string | undefined>;
}

const REAL_LIVENESS: Liveness = { alive: isProcessAlive, startTime: (pid) => getProcessStartTime(pid) };

export interface DiscoveryScan {
  live: LiveWindow[];
  /** The process is alive but its start time could not be read: not used, and never treated as stale. */
  unverified: LiveWindow[];
  /** Files whose process is gone or is a different run: never used. */
  stale: string[];
  /** Files that could not be trusted (permissions, owner, link, unreadable). */
  unsafe: Array<{ file: string; reason: string }>;
}

/** Reads every discovery file and sorts them into live, stale and unsafe. Never deletes. */
export async function scanDiscovery(directory: string, liveness: Liveness = REAL_LIVENESS): Promise<DiscoveryScan> {
  const scan: DiscoveryScan = { live: [], unverified: [], stale: [], unsafe: [] };
  await assertOwnerOnly(directory, 'directory');

  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.json') && !entry.startsWith('.')).sort()) {
    // path-join disposition: the name comes from readdir, which cannot return a name with a separator, and the folder was checked with assertOwnerOnly, so the joined file stays inside it.
    const file = join(directory, name);
    try {
      await assertOwnerOnly(file, 'file');
      const record = parseDiscovery(await readFile(file, 'utf8'));
      if (!record) {
        scan.unsafe.push({ file, reason: 'not a valid discovery file' });
      } else if (!isExpectedSocketPath(record.socketPath)) {
        scan.unsafe.push({ file, reason: 'it names a socket this extension would not create' });
      } else if (!liveness.alive(record.pid)) {
        scan.stale.push(file);
      } else {
        // Stale only when the start time is readable and different. If it cannot be read the
        // window may still be running: the file is kept and the shim says it could not verify.
        const start = await liveness.startTime(record.pid);
        if (start === undefined) {
          scan.unverified.push({ file, record });
        } else if (start !== record.startTime) {
          scan.stale.push(file);
        } else {
          scan.live.push({ file, record });
        }
      }
    } catch (error) {
      scan.unsafe.push({ file, reason: (error as Error).message });
    }
  }
  return scan;
}

export type Selection = { ok: true; window: LiveWindow } | { ok: false; message: string };

/**
 * True when two folder paths name the same place. Windows file names are case-insensitive, and VS Code
 * reports a drive letter in lower case (`c:\\work`) while a person types it in upper case (`C:\\work`).
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  // path-join disposition: the two folder names are only resolved so they can be compared; no file is read or written, so a ".." segment cannot be followed.
  const left = platform === 'win32' ? win32.resolve(a) : resolve(a);
  // path-join disposition: the other folder name is resolved the same way and for the same reason: a comparison of two names, not a file access.
  const right = platform === 'win32' ? win32.resolve(b) : resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function describe(window: LiveWindow): string {
  return `  ${safeText(window.record.label, 80)} (process ${window.record.pid}; folders: ${window.record.workspaceFolders.map((folder) => safeText(folder, 120)).join(', ') || 'none'})`;
}

/**
 * Picks the window to connect to. With a workspace argument (a folder path, a folder name or
 * the window label) it must match exactly one live window; without one there must be exactly
 * one live window. It never guesses.
 */
export function selectWindow(live: readonly LiveWindow[], workspace: string | undefined, unverified: readonly LiveWindow[] = []): Selection {
  if (live.length === 0 && unverified.length > 0) {
    return {
      ok: false,
      message: `Could not verify the window: its process is running but its start time could not be read, so the token was not sent. Nothing was changed. Windows:\n${unverified.map(describe).join('\n')}`
    };
  }
  if (live.length === 0) {
    return {
      ok: false,
      message: 'No VS Code window is running the FileMaker AI server. Enable filemaker.ai.externalServer.enabled in your user settings and run "FileMaker: Start/Stop AI Server for External Tools".'
    };
  }

  const wanted = workspace?.trim();
  const candidates = wanted
    ? live.filter(
        (window) =>
          window.record.label === wanted ||
          window.record.workspaceFolders.some((folder) => samePath(folder, wanted) || basename(folder) === wanted)
      )
    : [...live];

  if (candidates.length === 1) {
    return { ok: true, window: candidates[0] as LiveWindow };
  }
  if (candidates.length === 0) {
    return { ok: false, message: `No live window matches "${safeText(wanted ?? '', 80)}". Live windows:\n${live.map(describe).join('\n')}` };
  }
  return {
    ok: false,
    message: `${candidates.length} windows match${wanted ? ` "${safeText(wanted, 80)}"` : ''}; not guessing. Pass --workspace (or set FM_AI_WORKSPACE) to one of:\n${candidates.map(describe).join('\n')}`
  };
}
