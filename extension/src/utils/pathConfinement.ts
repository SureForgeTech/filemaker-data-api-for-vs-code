import { lstat, realpath } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export class PathConfinementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PathConfinementError';
  }
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Presentation selectors attached to a visible pictograph are part of its name, not hidden text. */
export function hasInvisiblePathCharacter(value: string): boolean {
  const visible = value.replace(/(\p{Extended_Pictographic})[\uFE0E\uFE0F]/gu, '$1');
  return /\p{C}|\u2028|\u2029|\p{Default_Ignorable_Code_Point}/u.test(visible);
}

/**
 * Checks the text of a configured path before it is resolved. Rejects: empty text, NUL,
 * `..` segments, `.git` segments, control or invisible characters (including the default-ignorable ones such as Hangul fillers, standalone variation selectors and the combining grapheme joiner; visible emoji presentation selectors are allowed), a segment ending in a dot or space, a
 * `~1` style short name, a reserved Windows device name, a colon anywhere except in the drive of a Windows absolute
 * path (`C:\x`; this also rules out drive-relative `C:x`), and a drive path on a system
 * without drives. Returns the trimmed text.
 */
export function validateConfiguredPath(raw: string, platform: NodeJS.Platform = process.platform): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new PathConfinementError('The path is empty.');
  }
  if (text.includes('\0')) {
    throw new PathConfinementError('The path contains a NUL character.');
  }

  const isDriveAbsolute = WINDOWS_DRIVE_ABSOLUTE.test(text);
  if (isDriveAbsolute && platform !== 'win32') {
    throw new PathConfinementError('A Windows drive path is not valid on this system.');
  }
  if ((isDriveAbsolute ? text.slice(2) : text).includes(':')) {
    throw new PathConfinementError('The path contains a colon (drive-relative Windows paths are not allowed).');
  }

  if (hasInvisiblePathCharacter(text)) {
    throw new PathConfinementError('The path contains a control or invisible character.');
  }

  for (const segment of text.split(/[\\/]+/)) {
    if (segment !== '' && segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) {
      throw new PathConfinementError('A part of the path ends with a dot or a space.');
    }
    if (/~\d/.test(segment)) {
      throw new PathConfinementError('A part of the path looks like a Windows short name (for example GIT~1).');
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new PathConfinementError('A part of the path is a reserved device name.');
    }
    if (segment === '..') {
      throw new PathConfinementError('The path contains "..".');
    }
    if (segment.toLowerCase() === '.git') {
      throw new PathConfinementError('The path points into a .git folder.');
    }
  }

  return text;
}

export interface ConfinedPath {
  /** Absolute path of the file, built from the real path of `root`. */
  path: string;
  /** The root (as given) that contains the file. */
  root: string;
  /** Path of the file relative to the root, with `/` separators. */
  relativePath: string;
}

/**
 * Resolves `candidate` (relative to `baseDir`, or absolute) and proves the result is a file
 * path inside one of `roots`:
 *  - it must be lexically inside a root (after `resolve`, so `..` cannot climb out);
 *  - no part of it below the root may be a symbolic link, whether or not the link points
 *    back inside. The root itself may be a link (for example `/tmp` on macOS); its real path
 *    is the base;
 *  - the file must not be an existing directory.
 * Parts that do not exist yet are fine; a new folder or file cannot be a link.
 */
export async function resolveConfinedFile(
  candidate: string,
  baseDir: string,
  roots: string[],
  platform: NodeJS.Platform = process.platform
): Promise<ConfinedPath> {
  const text = validateConfiguredPath(candidate, platform);
  // path-join disposition: validateConfiguredPath above refuses every ".." segment, and the result is compared with the roots below, so this resolve cannot climb out of a root.
  const absolute = resolve(baseDir, text);

  for (const root of roots) {
    // path-join disposition: the root is the trusted folder the caller passes in; it is the base the candidate is compared against, not a part an input can change.
    const lexicalRoot = resolve(root);
    const rel = relative(lexicalRoot, absolute);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      continue;
    }

    let realRoot: string;
    try {
      realRoot = await realpath(lexicalRoot);
    } catch {
      realRoot = lexicalRoot;
    }

    const parts = rel.split(sep).filter((part) => part.length > 0);
    let current = realRoot;
    for (let index = 0; index < parts.length; index += 1) {
      // path-join disposition: the part comes from the relative path that was proved to be inside the root, and every existing step is lstat'ed below, so a symbolic link cannot be followed.
      current = join(current, parts[index] as string);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          break;
        }
        throw new PathConfinementError('The path cannot be checked.');
      }

      if (stats.isSymbolicLink()) {
        throw new PathConfinementError('The path goes through a symbolic link.');
      }
      const isLast = index === parts.length - 1;
      if (isLast && stats.isDirectory()) {
        throw new PathConfinementError('The path is a folder, not a file.');
      }
      if (!isLast && !stats.isDirectory()) {
        throw new PathConfinementError('A part of the path is a file, not a folder.');
      }
    }

    return {
      // path-join disposition: the parts are the ones that were checked above and the real path of the root, so the joined file is the confined file that was proved to be inside the root.
      path: join(realRoot, ...parts),
      root,
      relativePath: parts.join('/')
    };
  }

  throw new PathConfinementError('The path is outside the workspace and the extension storage folder.');
}
