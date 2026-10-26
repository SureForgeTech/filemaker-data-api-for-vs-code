import { randomUUID } from 'crypto';
import { mkdir, open, rm, stat } from 'fs/promises';
import { dirname, join, basename } from 'path';
import { renameReplacing } from './renameReplacing';

/** Publish only a complete export, preserving existing modes and replacing links without following them. */
export async function atomicExport(path: string) {
  await mkdir(dirname(path), { recursive: true });
  // path-join disposition: the temporary file is written next to the export target the user picked, in the same folder, so it stays inside that folder.
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let finished = false;
  return {
    async write(text: string): Promise<void> { await file.writeFile(text, 'utf8'); },
    async close(): Promise<void> {
      if (finished) return;
      try {
        try {
          const existing = await stat(path);
          await file.chmod(existing.mode & 0o777);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // New file: keep the owner-only default mode.
        }
        await file.close();
        await renameReplacing(temporary, path);
        finished = true;
      } catch (error) {
        await file.close().catch(() => undefined);
        await rm(temporary, { force: true });
        finished = true;
        throw error;
      }
    },
    async abort(): Promise<void> {
      if (finished) return;
      finished = true;
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  };
}
