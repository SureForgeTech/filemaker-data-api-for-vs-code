import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SchemaDiffResult } from '../../../src/types/fm';
import { SchemaDiffPanel } from '../../../src/webviews/schemaDiff';

/**
 * Which message of the Schema Diff panel reaches which host call, what the panel answers, and what
 * it refuses. The panel is not changed here: every expectation reads what the code does today.
 */

type Handler = (message: unknown) => void;

const diff: SchemaDiffResult = {
  profileId: 'p1',
  layout: 'Contacts',
  comparedAt: '2026-01-01T00:00:00Z',
  added: [],
  removed: [],
  changed: [],
  summary: { added: 0, removed: 0, changed: 0 },
  hasChanges: false
};

/** Lets every pending promise of the panel settle before the expectations run. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function open(result: SchemaDiffResult = diff) {
  let handler: Handler | undefined;
  let onDispose: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const reveal = vi.fn();

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: Record<string, unknown>) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (callback: Handler) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    reveal,
    onDidDispose: (callback: () => void) => {
      onDispose = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const logger = { error: vi.fn() };

  (SchemaDiffPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  SchemaDiffPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, result, logger);

  const send = async (message: unknown): Promise<void> => {
    handler?.(message);
    await flush();
  };

  return {
    send,
    posted,
    reveal,
    logger,
    close: () => onDispose?.()
  };
}

describe('Schema Diff: message routing', () => {
  let panel: ReturnType<typeof open>;

  beforeEach(() => {
    vi.clearAllMocks();
    panel = open();
  });

  afterEach(() => {
    panel.close();
    (SchemaDiffPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  describe('every message reaches its handler', () => {
    it('answers "ready" with the diff', async () => {
      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'diff', payload: diff });
    });

    it('writes the diff as JSON for "exportJson"', async () => {
      const target = vscode.Uri.file('/tmp/schema-diff.json');
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(target as never);

      await panel.send({ type: 'exportJson' });

      const [options] = vi.mocked(vscode.window.showSaveDialog).mock.calls[0] as unknown as [
        { title: string; defaultUri: { fsPath: string }; filters: Record<string, string[]> }
      ];
      expect(options.title).toBe('Export schema diff JSON');
      expect(options.defaultUri.fsPath).toBe('schema-diff-Contacts.json');
      expect(options.filters).toEqual({ JSON: ['json'] });
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
      const [uri, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0] as [unknown, Buffer];
      expect(uri).toBe(target);
      expect(bytes.toString('utf8')).toBe(`${JSON.stringify(diff, null, 2)}\n`);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Exported schema diff to /tmp/schema-diff.json');
    });

    it.each([
      ['../ Layout/Name\\x\0', 'Layout-Name-x'], ['..', 'export'], ['CON', '_CON'], ['LPT1', '_LPT1']
    ])('uses a safe default path for layout %j without changing the exported name', async (layout, safe) => {
      panel.close();
      panel = open({ ...diff, layout });
      const target = vscode.Uri.file('/tmp/schema-diff.json');
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(target as never);
      await panel.send({ type: 'exportJson' });
      expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
        defaultUri: expect.objectContaining({ fsPath: `schema-diff-${safe}.json` })
      }));
      const bytes = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]![1] as Buffer;
      expect(JSON.parse(bytes.toString()).layout).toBe(layout);
    });

    it('writes nothing when the save dialog is dismissed', async () => {
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(undefined as never);

      await panel.send({ type: 'exportJson' });

      expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(1);
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(panel.posted).toEqual([]);
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('ignores a message of an unknown type: nothing is posted and nothing is written', async () => {
      await panel.send({ type: 'somethingElse' });

      expect(panel.posted).toEqual([]);
      expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(panel.logger.error).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object, or that has no type', async () => {
      for (const message of [null, 'ready', 42, { payload: {} }]) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
    });
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a diff that cannot be written, in the panel error shape', async () => {
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(vscode.Uri.file('/tmp/schema-diff.json') as never);
      vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(new Error('The file could not be written.'));

      await panel.send({ type: 'exportJson' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The file could not be written.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Schema diff request failed.', {
        type: 'exportJson',
        error: expect.any(Error)
      });
    });

    it('reports a failure that is not an Error with a plain reason', async () => {
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(vscode.Uri.file('/tmp/schema-diff.json') as never);
      vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce('the disk is full');

      await panel.send({ type: 'exportJson' });

      expect(panel.posted).toContainEqual({
        type: 'error',
        message: 'Unexpected error in the schema diff panel.'
      });
    });
  });

  describe('the panel is opened once and reused', () => {
    it('reveals the open panel and sends the new diff instead of opening a second one', async () => {
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;
      const other: SchemaDiffResult = { ...diff, layout: 'Orders' };

      SchemaDiffPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, other, panel.logger);
      await flush();

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(1);
      expect(panel.reveal).toHaveBeenCalledTimes(1);
      expect(panel.posted.slice(before)).toContainEqual({ type: 'diff', payload: other });
    });

    it('lets the next request open a new panel once the old one was closed', async () => {
      panel.close();

      SchemaDiffPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, diff, panel.logger);

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(2);
    });
  });
});
