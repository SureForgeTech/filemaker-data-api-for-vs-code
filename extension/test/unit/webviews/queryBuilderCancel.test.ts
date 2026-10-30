import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HistoryStore } from '../../../src/services/historyStore';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import type { QueryBuilderContext } from '../../../src/webviews/queryBuilder/context';
import { handleRunQuery } from '../../../src/webviews/queryBuilder/find';
import { getHtmlForWebview } from '../../../src/webviews/queryBuilder/html';
import { parseIncomingMessage } from '../../../src/webviews/queryBuilder/messages';
import { InMemoryMemento } from '../mocks';
import { JSDOM, loadPage, type DomElement } from '../../helpers/jsdomPage';

/**
 * A query that is already running can be stopped. The page asks for that with the id of the
 * run it is waiting on, the host aborts the request in flight, and the page is told the run
 * was cancelled so it stops waiting.
 */

type Handler = (message: unknown) => void;

const profile = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com',
  database: 'Sales'
};

const runPayload = {
  profileId: 'p1',
  layout: ' Contacts ',
  findJson: '[{" Name ":"Ada"}]',
  runId: 7
};

/** The cancellation the client accepts, as the host passes it on. */
interface RequestControl {
  signal?: AbortSignal;
}

/** A find that only ends when its signal is aborted, like a request waiting on a slow server. */
function abortableFind() {
  return vi.fn(
    async (_profile: unknown, _layout: unknown, _body: unknown, control?: RequestControl) => {
      await new Promise<void>((_resolve, reject) => {
        const signal = control?.signal;
        if (signal?.aborted) {
          reject(new Error('The request was aborted.'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('The request was aborted.')));
      });
      return { data: [], dataInfo: { foundCount: 0 } };
    }
  );
}

function stubContext(client: Record<string, unknown>) {
  const posted: Array<Record<string, unknown>> = [];
  const context = {
    panel: {
      webview: {
        postMessage: vi.fn(async (message: Record<string, unknown>) => {
          posted.push(message);
          return true;
        })
      }
    },
    profileStore: { getProfile: vi.fn(async () => profile) },
    fmClient: client,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    postError: vi.fn(async (message: string, runId?: number) => {
      posted.push({ type: 'error', message, ...(runId === undefined ? {} : { runId }) });
    }),
    formatError: (error: unknown) => (error instanceof Error ? error.message : 'Unknown error.'),
    sendHistory: vi.fn(async () => undefined),
    toCsvRows: vi.fn(() => [])
  } as unknown as QueryBuilderContext;

  return { context, posted };
}

describe('The Query Builder host aborts a run in flight', () => {
  it('reports the run as cancelled instead of as a failure', async () => {
    const findRecords = abortableFind();
    const { context, posted } = stubContext({ findRecords });

    const run = handleRunQuery(context, runPayload);
    await vi.waitFor(() => expect(context.activeRun?.runId).toBe(7));

    context.activeRun?.controller.abort();
    await run;

    expect(findRecords).toHaveBeenCalledWith(
      profile,
      ' Contacts ',
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(posted).toContainEqual({ type: 'runCancelled', runId: 7 });
    expect(posted.some((message) => message.type === 'error')).toBe(false);
    expect(context.activeRun).toBeUndefined();
  });

  it('gives a list run the same signal', async () => {
    const listRecords = abortableFind();
    const { context, posted } = stubContext({ listRecords });

    const run = handleRunQuery(context, { ...runPayload, listRecords: true });
    await vi.waitFor(() => expect(context.activeRun?.runId).toBe(7));

    context.activeRun?.controller.abort();
    await run;

    expect(listRecords).toHaveBeenCalledWith(
      profile,
      ' Contacts ',
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(posted).toContainEqual({ type: 'runCancelled', runId: 7 });
    expect(posted.some((message) => message.type === 'error')).toBe(false);
    expect(context.activeRun).toBeUndefined();
  });

  it('still reports a run that failed for another reason as a failure', async () => {
    const { context, posted } = stubContext({
      findRecords: vi.fn(async () => {
        throw new Error('Field is missing');
      })
    });

    await handleRunQuery(context, runPayload);

    expect(posted).toContainEqual({ type: 'error', message: 'Field is missing', runId: 7 });
    expect(posted.some((message) => message.type === 'runCancelled')).toBe(false);
    expect(context.activeRun).toBeUndefined();
  });

  it('reports an early cancel once and skips the Data API after profile lookup settles', async () => {
    let resolveProfile!: (value: typeof profile) => void;
    const getProfile = vi.fn(() => new Promise<typeof profile>((resolve) => { resolveProfile = resolve; }));
    const findRecords = vi.fn();
    const { context, posted } = stubContext({ findRecords });
    context.profileStore.getProfile = getProfile as never;

    const run = handleRunQuery(context, runPayload);
    expect(context.activeRun?.runId).toBe(7);
    context.activeRun!.controller.abort();
    resolveProfile(profile);
    await run;

    expect(findRecords).not.toHaveBeenCalled();
    expect(posted.filter((message) => message.type === 'runCancelled')).toEqual([
      { type: 'runCancelled', runId: 7 }
    ]);
    expect(context.activeRun).toBeUndefined();
  });

  it('reports an early cancel once when profile lookup rejects, without an error or history post', async () => {
    let rejectProfile!: (error: Error) => void;
    const getProfile = vi.fn(() => new Promise<typeof profile>((_resolve, reject) => { rejectProfile = reject; }));
    const findRecords = vi.fn();
    const { context, posted } = stubContext({ findRecords });
    context.profileStore.getProfile = getProfile as never;

    const run = handleRunQuery(context, runPayload);
    expect(context.activeRun?.runId).toBe(7);
    context.activeRun!.controller.abort();
    rejectProfile(new Error('Profile lookup failed'));
    await run;

    expect(findRecords).not.toHaveBeenCalled();
    expect(posted.filter((message) => message.type === 'runCancelled')).toEqual([
      { type: 'runCancelled', runId: 7 }
    ]);
    expect(posted.some((message) => message.type === 'error')).toBe(false);
    expect(context.sendHistory).not.toHaveBeenCalled();
    expect(context.activeRun).toBeUndefined();
  });
});

describe('The Query Builder panel routes a cancel', () => {
  function openPanel() {
    let handler: Handler | undefined;
    let onDispose: (() => void) | undefined;
    const posted: Array<Record<string, unknown>> = [];
    let resolveProfile!: (value: typeof profile) => void;

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
      reveal: vi.fn(),
      onDidDispose: (callback: () => void) => {
        onDispose = callback;
        return { dispose: vi.fn() };
      }
    } as never);

    const fmClient = {
      listLayouts: vi.fn(async () => [' Contacts ']),
      getLayoutMetadata: vi.fn(async () => ({})),
      findRecords: abortableFind(),
      listRecords: vi.fn(async () => ({ data: [], dataInfo: { foundCount: 0 } }))
    };
    const savedQueriesStore = {
      listSavedQueries: vi.fn(async () => []),
      getSavedQuery: vi.fn(async () => undefined),
      saveSavedQuery: vi.fn(async (query: Record<string, unknown>) => ({ ...query, id: 'q-new' }))
    };
    const profileStore = {
      listProfiles: vi.fn(async () => [profile]),
      getProfile: vi.fn((id: string) => id === 'pending'
        ? new Promise<typeof profile>((resolve) => { resolveProfile = resolve; })
        : Promise.resolve(id === profile.id ? profile : undefined)),
      getActiveProfileId: vi.fn(() => profile.id)
    };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    QueryBuilderPanel.createOrShow(
      { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
      profileStore as never,
      savedQueriesStore as never,
      fmClient as never,
      logger as never,
      undefined,
      new HistoryStore(new InMemoryMemento() as never)
    );

    const send = async (message: unknown): Promise<void> => {
      handler?.(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    return { send, posted, fmClient, close: () => onDispose?.(), resolveProfile: () => resolveProfile(profile) };
  }

  let panel: ReturnType<typeof openPanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    panel = openPanel();
  });

  afterEach(() => {
    panel.close();
    (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  it('aborts the run the page names and tells the page the run was cancelled', async () => {
    await panel.send({ type: 'runQuery', payload: runPayload });
    await panel.send({ type: 'cancelRun', runId: 7 });

    await vi.waitFor(() =>
      expect(panel.posted).toContainEqual({ type: 'runCancelled', runId: 7 })
    );
    expect(panel.posted.some((message) => message.type === 'error')).toBe(false);
    expect(panel.posted.some((message) => message.type === 'queryResult')).toBe(false);
  });

  it('leaves a run alone when the cancel names another run', async () => {
    await panel.send({ type: 'runQuery', payload: runPayload });
    await panel.send({ type: 'cancelRun', runId: 99 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panel.posted.some((message) => message.type === 'runCancelled')).toBe(false);

    // The run is still going, so the cancel that names it still stops it.
    await panel.send({ type: 'cancelRun', runId: 7 });
    await vi.waitFor(() =>
      expect(panel.posted).toContainEqual({ type: 'runCancelled', runId: 7 })
    );
  });

  it('ignores a cancel when no run is in flight', async () => {
    await panel.send({ type: 'cancelRun', runId: 7 });

    expect(panel.posted).toEqual([]);
    expect(panel.fmClient.findRecords).not.toHaveBeenCalled();
  });

  it('cancels a pending lookup once and ends the page running state', async () => {
    await panel.send({ type: 'runQuery', payload: { ...runPayload, profileId: 'pending' } });
    await panel.send({ type: 'cancelRun', runId: 7 });
    panel.resolveProfile();
    await vi.waitFor(() => expect(panel.posted.filter((message) => message.type === 'runCancelled')).toHaveLength(1));

    expect(panel.fmClient.findRecords).not.toHaveBeenCalled();
    expect(panel.posted.some((message) => message.type === 'error')).toBe(false);
  });

  it('aborts a pending lookup on disposal and does not call or post after it settles', async () => {
    const activeRun = (QueryBuilderPanel as unknown as { currentPanel: { query: QueryBuilderContext } }).currentPanel.query;
    activeRun.lastResult = {
      profileId: 'p1', layout: ' Contacts ', query: runPayload,
      result: { data: [], dataInfo: { foundCount: 0 } }
    };
    await panel.send({ type: 'runQuery', payload: { ...runPayload, profileId: 'pending' } });
    expect(activeRun.activeRun).toBeDefined();
    panel.close();
    expect(activeRun.activeRun).toBeUndefined();
    expect(activeRun.lastResult).toBeUndefined();
    panel.resolveProfile();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panel.fmClient.findRecords).not.toHaveBeenCalled();
    expect(panel.posted).toEqual([]);
  });
});

describe('The cancel message is checked before it is used', () => {
  it('accepts a run id', () => {
    expect(parseIncomingMessage({ type: 'cancelRun', runId: 1 })).toEqual({
      type: 'cancelRun',
      runId: 1
    });
    expect(parseIncomingMessage({ type: 'cancelRun', runId: 0 })).toEqual({
      type: 'cancelRun',
      runId: 0
    });
  });

  it('refuses a cancel without a usable run id', () => {
    expect(parseIncomingMessage({ type: 'cancelRun' })).toBeUndefined();
    expect(parseIncomingMessage({ type: 'cancelRun', runId: '1' })).toBeUndefined();
    expect(parseIncomingMessage({ type: 'cancelRun', runId: 1.5 })).toBeUndefined();
    expect(parseIncomingMessage({ type: 'cancelRun', runId: -1 })).toBeUndefined();
    expect(parseIncomingMessage({ type: 'cancelRun', runId: Number.NaN })).toBeUndefined();
    expect(
      parseIncomingMessage({ type: 'cancelRun', runId: Number.POSITIVE_INFINITY })
    ).toBeUndefined();
  });
});

describe.skipIf(!JSDOM)('The Query Builder page offers a cancel', () => {
  /** The real page, running against the real HTML the host gives it. */
  function openPage() {
    const html = getHtmlForWebview(
      { cspSource: 'vscode-resource:', asWebviewUri: (uri: unknown) => uri } as never,
      { fsPath: '/ext' } as never
    );
    const source = [
      readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/cellText.js'), 'utf8'),
      readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/findForm.js'), 'utf8'),
      readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/index.js'), 'utf8')
    ].join('\n');

    return loadPage(html, source);
  }

  /** Puts a find request on screen and starts a run of it. */
  function startRun(document: { getElementById(id: string): DomElement | null }): void {
    document.getElementById('jsonTab')!.click();
    document.getElementById('findJson')!.value = '[{"Name":"*"}]';
    document.getElementById('runButton')!.click();
  }

  it('shows the cancel while a query runs and reports the run as cancelled', () => {
    const { document, send, posted } = openPage();
    send({ type: 'init', payload: { profiles: [profile], activeProfileId: 'p1' } });
    send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: [' Contacts '] } });

    const cancelButton = document.getElementById('cancelButton')!;
    expect(cancelButton.classList.contains('hidden')).toBe(true);

    startRun(document);

    expect(cancelButton.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('runButton')!.getAttribute('disabled')).not.toBeNull();

    cancelButton.click();
    expect(posted.filter((message) => message.type === 'cancelRun')).toEqual([
      { type: 'cancelRun', runId: 1 }
    ]);

    // The button is disabled after the click, so a second click cannot cancel twice.
    expect(cancelButton.disabled).toBe(true);
    cancelButton.click();
    expect(posted.filter((message) => message.type === 'cancelRun')).toHaveLength(1);

    send({ type: 'runCancelled', runId: 1 });
    expect(cancelButton.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('runButton')!.getAttribute('disabled')).toBeNull();
    expect(document.getElementById('status')!.textContent).toBe('Query cancelled.');
  });

  it('keeps the results already on screen when a run is cancelled', () => {
    const { document, send } = openPage();
    send({ type: 'init', payload: { profiles: [profile], activeProfileId: 'p1' } });
    send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: [' Contacts '] } });
    send({
      type: 'queryResult',
      payload: {
        query: { layout: ' Contacts ' },
        result: { data: [{ recordId: '1', fieldData: { Name: 'KEPT RESULT' } }] }
      }
    });

    startRun(document);
    send({ type: 'runCancelled', runId: 1 });

    expect(document.body.textContent).toContain('KEPT RESULT');
    expect(document.getElementById('status')!.textContent).toBe('Query cancelled.');
  });
});
