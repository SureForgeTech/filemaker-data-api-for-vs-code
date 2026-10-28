import { access, readFile } from 'fs/promises';
import path from 'path';

import { migrateLayoutDefinition, type LayoutDefinition } from '@fmweb/shared';

export async function loadLayoutDefinition(id: string): Promise<LayoutDefinition | undefined> {
  const layoutsDir = await resolveLayoutsDir();
  const fileName = `${safeId(id)}.layout.json`;
  // path-join disposition: safeId() replaces every character that is not a letter, a digit, "-" or "_", so the file name has no separator and no ".." segment and stays in the layouts folder.
  const filePath = path.join(layoutsDir, fileName);

  try {
    const raw = await readFile(filePath, 'utf8');
    return migrateLayoutDefinition(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function resolveLayoutsDir(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), '..', 'layouts'),
    path.join(process.cwd(), '.fmweb', 'generated', 'layouts'),
    path.join(process.cwd(), 'generated', 'layouts')
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-_]/g, '_');
}
