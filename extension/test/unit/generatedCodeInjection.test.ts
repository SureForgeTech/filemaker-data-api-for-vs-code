import { mkdtemp, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript6';
import { describe, expect, it, vi } from 'vitest';

import { TypeGenService } from '../../src/services/typeGenService';
import type { ConnectionProfile } from '../../src/types/fm';

/**
 * Layout, field and profile names come from the FileMaker database (and profile names from
 * a template), so whoever can name them must not be able to put code into generated files.
 */

const HOSTILE = "X */ evil_marker(); /* \n evil_marker();\u2028evil_marker(); // ' ${evil_marker()} `";

function profile(): ConnectionProfile {
  return { id: HOSTILE, name: HOSTILE, authMode: 'direct', serverUrl: 'https://fm.local', database: 'DB', username: 'u' };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function callsTo(source: string, name: string): number {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ESNext, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

describe('generated code from hostile names', () => {
  it('writes names into comments and strings only, never as code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-inject-'));
    const schemaService = {
      getLayoutSchema: vi.fn().mockResolvedValue({
        supported: true,
        fromCache: false,
        metadata: { fieldMetaData: [{ name: HOSTILE, type: 'text' }] },
        fields: [{ name: HOSTILE, type: 'text' }]
      })
    };
    const service = new TypeGenService(schemaService as never, { listLayouts: vi.fn().mockResolvedValue([HOSTILE]) } as never, logger, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const layout = await service.generateTypesForLayout(profile(), HOSTILE);
    const client = await service.generateTypeScriptClient(profile(), [HOSTILE], root);
    const sources = [
      layout.content,
      await readFile(client.typesPath, 'utf8'),
      await readFile(client.clientPath, 'utf8')
    ];

    for (const source of sources) {
      expect(callsTo(source, 'evil_marker')).toBe(0);
    }
  });

  it('keeps snippet placeholders intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-snip-'));
    const service = new TypeGenService({} as never, {} as never, logger, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const snippets = await service.generateSnippetsForLayout(profile(), "O'Brien}$");
    const parsed = JSON.parse(snippets.content.replace(/^\/\/[^\n]*\n/, '')) as Record<string, { body: string[] }>;
    const body = Object.values(parsed).flatMap((entry) => entry.body).join('\n');

    expect(body).toContain("O\\\\'Brien\\}\\$");
  });

  it('gives layouts that differ only by punctuation separate files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-names-'));
    const schemaService = {
      getLayoutSchema: vi.fn().mockResolvedValue({ supported: true, fromCache: false, metadata: {}, fields: [] })
    };
    const service = new TypeGenService(schemaService as never, { listLayouts: vi.fn().mockResolvedValue(['A/B', 'A:B']) } as never, logger, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const a = await service.generateTypesForLayout(profile(), 'A/B');
    const b = await service.generateTypesForLayout(profile(), 'A:B');

    expect(a.filePath).not.toBe(b.filePath);
    expect((await readdir(join(root, 'filemaker-types', 'layouts'))).length).toBe(2);
  });
});
