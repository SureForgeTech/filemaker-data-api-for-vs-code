import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlankLayout } from '../../../src/fmweb/layoutSchema';
import { LayoutModePanel } from '../../../src/webviews/layoutMode';

/**
 * Which message of Layout Mode reaches which service, what the panel answers, and what it
 * refuses. The panel is not changed here: every expectation reads what the code does today.
 */

type Handler = (message: unknown) => void;

const layout = createBlankLayout('Customers', 'Contacts');

/** Lets every pending promise of the panel settle before the expectations run. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Overrides {
  ensureProjectInitialized?: () => Promise<unknown>;
  getDesignerLayouts?: () => Promise<unknown[]>;
  saveLayout?: () => Promise<void>;
  getProfile?: () => Promise<unknown>;
  getActiveProfileId?: () => string | undefined;
}

function open(overrides: Overrides = {}) {
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

  const fmWebProjectService = {
    ensureProjectInitialized: vi.fn(overrides.ensureProjectInitialized ?? (async () => ({ name: 'Project' }))),
    loadOrCreateLayout: vi.fn(async () => ({ layout, source: 'existing' })),
    loadMetadataCache: vi.fn(async () => ({ scripts: [], layoutMetadata: [] })),
    getDesignerLayouts: vi.fn(
      overrides.getDesignerLayouts ?? (async () => [{ layoutName: 'Contacts', fields: [], portals: [] }])
    ),
    getAvailableFields: vi.fn(async () => [' Name ']),
    saveLayout: vi.fn(overrides.saveLayout ?? (async () => undefined)),
    readProjectConfig: vi.fn(async () => undefined)
  };
  const profileStore = {
    getActiveProfileId: vi.fn(overrides.getActiveProfileId ?? (() => undefined)),
    getProfile: vi.fn(overrides.getProfile ?? (async () => undefined))
  };
  const fmClient = { runScript: vi.fn(async () => ({ scriptResult: 'ok' })) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  (LayoutModePanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  LayoutModePanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    fmWebProjectService as never,
    profileStore as never,
    fmClient as never,
    logger as never,
    { assertScriptRunAllowed: async () => true }
  );

  const send = async (message: unknown): Promise<void> => {
    handler?.(message);
    await flush();
  };

  return {
    send,
    posted,
    reveal,
    fmWebProjectService,
    profileStore,
    fmClient,
    logger,
    close: () => onDispose?.()
  };
}

describe('Layout Mode: message routing', () => {
  let panel: ReturnType<typeof open>;

  beforeEach(() => {
    vi.clearAllMocks();
    panel = open();
  });

  afterEach(() => {
    panel.close();
    (LayoutModePanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  describe('every message reaches its handler', () => {
    it('answers "loadTemplateMetadata" with the metadata of that layout', async () => {
      await panel.send({ type: 'loadTemplateMetadata', payload: { layoutName: 'Contacts' } });

      expect(panel.fmWebProjectService.getDesignerLayouts).toHaveBeenCalledWith(['Contacts']);
      expect(panel.posted).toContainEqual({
        type: 'templateMetadata',
        payload: { layoutName: 'Contacts', fields: [], portals: [] }
      });
    });

    it('saves the layout for "saveLayout" and says that it was saved', async () => {
      await panel.send({ type: 'saveLayout', payload: { layout } });

      expect(panel.fmWebProjectService.saveLayout).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Customers', fmLayoutName: 'Contacts' })
      );
      expect(panel.posted).toContainEqual({ type: 'saveResult', payload: { ok: true, message: 'Layout saved.' } });
    });

    it('says that an autosave was an autosave', async () => {
      await panel.send({ type: 'saveLayout', payload: { layout, autosave: true } });

      expect(panel.posted).toContainEqual({ type: 'saveResult', payload: { ok: true, message: 'Autosaved layout.' } });
    });

    it('runs the behaviour for "executeBehavior" and reports the result', async () => {
      await panel.send({
        type: 'executeBehavior',
        payload: {
          layoutId: 'layout-1',
          layoutName: 'Customers',
          objectId: 'obj-1',
          objectName: 'Open Customers',
          behavior: { type: 'goToWebLayout', targetLayoutId: 'layout-2' }
        }
      });

      expect(panel.posted).toContainEqual({
        type: 'behaviorResult',
        payload: {
          ok: true,
          action: 'goToWebLayout',
          stub: true,
          message: 'Preview stub: would navigate to web layout "layout-2".'
        }
      });
      expect(panel.logger.warn).not.toHaveBeenCalled();
    });

    it('writes a behaviour that did not work to the log, and reports it to the page', async () => {
      await panel.send({
        type: 'executeBehavior',
        payload: {
          layoutId: 'layout-1',
          layoutName: 'Customers',
          objectId: 'obj-1',
          objectName: 'Delete Everything',
          behavior: { type: 'runScript' }
        }
      });

      expect(panel.logger.warn).toHaveBeenCalledWith(
        'Layout behavior execution reported a non-ok result.',
        { scriptName: undefined, layout: 'Customers', codes: [] }
      );
      expect(panel.posted).toContainEqual({
        type: 'behaviorResult',
        payload: {
          ok: false,
          action: 'runScript',
          stub: true,
          message: 'Delete Everything is missing a script name.'
        }
      });
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('ignores a message of an unknown type: nothing is posted and no service is called', async () => {
      await panel.send({ type: 'somethingElse', payload: { layoutName: 'Contacts' } });

      expect(panel.posted).toEqual([]);
      expect(panel.fmWebProjectService.getDesignerLayouts).not.toHaveBeenCalled();
      expect(panel.fmWebProjectService.saveLayout).not.toHaveBeenCalled();
      expect(panel.logger.error).not.toHaveBeenCalled();
      expect(panel.logger.warn).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object, or that has no type', async () => {
      for (const message of [null, 'ready', 42, { payload: { layoutName: 'Contacts' } }]) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.fmWebProjectService.getDesignerLayouts).not.toHaveBeenCalled();
    });

    it('ignores a template request without a layout name', async () => {
      await panel.send({ type: 'loadTemplateMetadata', payload: {} });
      await panel.send({ type: 'loadTemplateMetadata', payload: { layoutName: 42 } });

      expect(panel.posted).toEqual([]);
      expect(panel.fmWebProjectService.getDesignerLayouts).not.toHaveBeenCalled();
    });

    it('ignores a layout that is not an object, or a save without a payload', async () => {
      await panel.send({ type: 'saveLayout' });
      await panel.send({ type: 'saveLayout', payload: 'not an object' });
      await panel.send({ type: 'saveLayout', payload: { layout: 'not an object' } });
      await panel.send({ type: 'saveLayout', payload: { layout: ['not', 'an', 'object'] } });

      expect(panel.posted).toEqual([]);
      expect(panel.fmWebProjectService.saveLayout).not.toHaveBeenCalled();
    });

    it('ignores a behaviour request that is missing what it needs', async () => {
      await panel.send({ type: 'executeBehavior' });
      await panel.send({ type: 'executeBehavior', payload: { layoutId: 'layout-1' } });
      await panel.send({
        type: 'executeBehavior',
        payload: { layoutId: 'layout-1', layoutName: 'Customers', objectId: 'obj-1', objectName: 'Button' }
      });

      expect(panel.posted).toEqual([]);
    });

    it('ignores a behaviour that is not a binding', async () => {
      await panel.send({
        type: 'executeBehavior',
        payload: {
          layoutId: 'layout-1',
          layoutName: 'Customers',
          objectId: 'obj-1',
          objectName: 'Button',
          behavior: 'not an object'
        }
      });

      expect(panel.posted).toEqual([]);
    });
  });

  it('logs names and script codes without parameters or server response details', async () => {
    panel.close();
    panel = open({ getActiveProfileId: () => 'p1', getProfile: async () => ({ id: 'p1', name: 'Test', serverUrl: 'https://example.test', authMode: 'direct' }) });
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run script' as never);
    panel.fmClient.runScript.mockResolvedValue({
      response: { scriptError: '3', scriptResult: 'private server response' }
    } as never);
    await panel.send({ type: 'executeBehavior', payload: {
      layoutId: 'layout-1', layoutName: ' Exact layout ', fmLayoutName: ' Exact source ', objectId: 'obj-1',
      objectName: 'Button', behavior: { type: 'runScript', scriptName: ' Exact script ', parameter: 'private parameter' }
    } });
    expect(panel.logger.warn).toHaveBeenCalledWith('Layout behavior execution reported a non-ok result.', {
      scriptName: ' Exact script ', layout: ' Exact source ', codes: ['3']
    });
    expect(JSON.stringify(panel.logger.warn.mock.calls)).not.toContain('private');
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a project that cannot be opened, in the payload the page reads', async () => {
      panel.close();
      panel = open({
        ensureProjectInitialized: async () => {
          throw new Error('The project could not be opened.');
        }
      });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({
        type: 'error',
        payload: { message: 'The project could not be opened.' }
      });
    });

    it('reports template metadata that cannot be read, in the payload the page reads', async () => {
      panel.fmWebProjectService.getDesignerLayouts.mockRejectedValueOnce(new Error('The template cannot be read.'));

      await panel.send({ type: 'loadTemplateMetadata', payload: { layoutName: 'Contacts' } });

      expect(panel.posted).toContainEqual({
        type: 'error',
        payload: { message: 'The template cannot be read.' }
      });
    });

    it('reports a layout that cannot be saved in the result the page reads', async () => {
      panel.fmWebProjectService.saveLayout.mockRejectedValueOnce(new Error('The layout could not be saved.'));

      await panel.send({ type: 'saveLayout', payload: { layout } });

      expect(panel.posted).toContainEqual({
        type: 'saveResult',
        payload: { ok: false, message: 'The layout could not be saved.' }
      });
      expect(panel.logger.error).toHaveBeenCalledWith('Failed to save layout from Layout Mode panel.', {
        error: expect.any(Error)
      });
    });

    it('reports a behaviour that could not be run in the result the page reads', async () => {
      panel.close();
      panel = open({
        getActiveProfileId: () => 'p1',
        getProfile: async () => {
          throw new Error('The profile could not be read.');
        }
      });

      await panel.send({
        type: 'executeBehavior',
        payload: {
          layoutId: 'layout-1',
          layoutName: 'Customers',
          objectId: 'obj-1',
          objectName: 'Delete Everything',
          behavior: { type: 'runScript', scriptName: 'Purge Records' }
        }
      });

      expect(panel.posted).toContainEqual({
        type: 'behaviorResult',
        payload: { ok: false, action: 'runScript', stub: false, message: 'The profile could not be read.' }
      });
      expect(panel.logger.error).toHaveBeenCalledWith(
        'Failed to execute layout behavior binding.',
        { scriptName: 'Purge Records', layout: 'Customers', code: undefined }
      );
    });

    it('reports a failure that is not an Error with a plain reason', async () => {
      panel.close();
      panel = open({
        ensureProjectInitialized: async () => {
          throw 'the socket closed';
        }
      });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({
        type: 'error',
        payload: { message: 'Unexpected Layout Mode error.' }
      });
    });
  });

  describe('the panel is opened once and reused', () => {
    it('reveals the open panel and sends the state of the layout that was asked for', async () => {
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;

      LayoutModePanel.createOrShow(
        { extensionUri: { fsPath: '/ext' } } as never,
        panel.fmWebProjectService as never,
        panel.profileStore as never,
        panel.fmClient as never,
        panel.logger as never,
        { layoutId: 'layout-2', assertScriptRunAllowed: async () => true }
      );
      await flush();

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(1);
      expect(panel.reveal).toHaveBeenCalledTimes(1);
      expect(panel.fmWebProjectService.loadOrCreateLayout).toHaveBeenCalledWith('layout-2');
      expect(panel.posted.length).toBeGreaterThan(before);
      expect(panel.posted.slice(before)).toContainEqual(
        expect.objectContaining({ type: 'init', payload: expect.objectContaining({ layout }) })
      );
    });
  });
});
