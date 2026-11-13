import { describe, expect, it, vi } from 'vitest';

import type { LayoutObject } from '@fmweb/shared';

import {
  executeRuntimeBehaviorAction,
  normalizeBridgeBaseUrl
} from './runtime-behavior';

function buttonObject(behavior?: LayoutObject['behavior']): LayoutObject {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'button',
    name: 'ActionButton',
    label: 'Action',
    x: 24,
    y: 24,
    width: 140,
    height: 36,
    zIndex: 0,
    anchors: {
      top: true,
      right: false,
      bottom: false,
      left: true
    },
    behavior
  };
}

describe('runtime behavior actions', () => {
  it('navigates to web layouts for goToWebLayout behavior', async () => {
    const navigateToLayout = vi.fn();

    const result = await executeRuntimeBehaviorAction(
      buttonObject({
        type: 'goToWebLayout',
        targetLayoutId: 'invoices'
      }),
      {
        layoutId: 'home-layout',
        layoutName: 'Home',
        currentRecordId: '17',
        currentRecordIndex: 1,
        currentFoundSetRecordIds: ['16', '17', '18'],
        navigateToLayout,
        openUrl: vi.fn(),
        showDialog: vi.fn()
      }
    );

    expect(result.ok).toBe(true);
    expect(result.stub).toBe(false);
    expect(navigateToLayout).toHaveBeenCalledWith(
      'invoices',
      expect.objectContaining({
        sourceLayoutId: 'home-layout',
        sourceLayoutName: 'Home',
        recordId: '17',
        currentRecordIndex: 1,
        foundSetRecordIds: ['16', '17', '18']
      })
    );
  });

  it('returns runScript stub result when bridge URL is not configured', async () => {
    const result = await executeRuntimeBehaviorAction(
      buttonObject({
        type: 'runScript',
        scriptName: 'Run_Web_Action',
        parameter: 'id=42'
      }),
      {
        layoutName: 'Contacts',
        navigateToLayout: vi.fn(),
        openUrl: vi.fn(),
        showDialog: vi.fn()
      }
    );

    expect(result.ok).toBe(true);
    expect(result.stub).toBe(true);
    expect(result.message).toContain('Runtime stub');
  });

  it('posts runScript requests to the configured bridge endpoint', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: { scriptResult: 'ok' } })
    })) as unknown as typeof fetch;

    const result = await executeRuntimeBehaviorAction(
      buttonObject({
        type: 'runScript',
        scriptName: 'Run_Web_Action',
        parameter: 'id=42'
      }),
      {
        layoutName: 'Contacts',
        fmLayoutName: 'FM_Contacts',
        bridgeBaseUrl: 'http://127.0.0.1:9876/fm/',
        navigateToLayout: vi.fn(),
        openUrl: vi.fn(),
        showDialog: vi.fn(),
        fetchFn
      }
    );

    expect(result.ok).toBe(true);
    expect(result.stub).toBe(false);
    expect(result.message).toContain('Executed script "Run_Web_Action"');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:9876/fm/runScript',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('sends the bridge token with runScript when the page has one, and none otherwise', async () => {
    const run = async (bridgeToken?: string) => {
      const fetchFn = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: {} })
      })) as unknown as typeof fetch;
      await executeRuntimeBehaviorAction(buttonObject({ type: 'runScript', scriptName: 'S' }), {
        layoutName: 'Contacts',
        bridgeBaseUrl: 'http://127.0.0.1:9876/fm',
        bridgeToken,
        navigateToLayout: vi.fn(),
        openUrl: vi.fn(),
        showDialog: vi.fn(),
        fetchFn
      });
      return (vi.mocked(fetchFn).mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    };

    expect((await run('session-token'))['X-FM-Bridge-Token']).toBe('session-token');
    expect(Object.keys(await run())).not.toContain('X-FM-Bridge-Token');
  });

  it('opens URLs and displays dialogs for behavior actions', async () => {
    const openUrl = vi.fn();
    const showDialog = vi.fn();

    const openResult = await executeRuntimeBehaviorAction(
      buttonObject({
        type: 'openUrl',
        url: 'https://example.com'
      }),
      {
        layoutName: 'Home',
        navigateToLayout: vi.fn(),
        openUrl,
        showDialog
      }
    );

    expect(openResult.ok).toBe(true);
    expect(openResult.stub).toBe(false);
    expect(openUrl).toHaveBeenCalledWith('https://example.com');

    const dialogResult = await executeRuntimeBehaviorAction(
      buttonObject({
        type: 'showDialog',
        dialogId: 'confirm-delete',
        parameter: 'record=1'
      }),
      {
        layoutName: 'Home',
        navigateToLayout: vi.fn(),
        openUrl,
        showDialog
      }
    );

    expect(dialogResult.ok).toBe(true);
    expect(dialogResult.stub).toBe(false);
    expect(showDialog).toHaveBeenCalledWith('confirm-delete', 'record=1');
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,evil',
    'file:///etc/passwd', 'command:workbench.action.closeWindow', 'ftp://example.com', '//example.com', '/relative', 'not a URL'])('A4 refuses hostile or non-HTTP URL %s', async (url) => {
    const openUrl = vi.fn();
    const result = await executeRuntimeBehaviorAction(buttonObject({ type: 'openUrl', url }), {
      layoutName: 'L', openUrl, navigateToLayout: vi.fn(), showDialog: vi.fn()
    });
    expect(result).toMatchObject({ ok: false, action: 'openUrl', stub: true });
    expect(result.message).toContain('Only http: and https:');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each(['http://example.com/a', 'HTTPS://example.com/a'])('A4 allows HTTP URLs %s', async (url) => {
    const openUrl = vi.fn();
    const result = await executeRuntimeBehaviorAction(buttonObject({ type: 'openUrl', url }), {
      layoutName: 'L', openUrl, navigateToLayout: vi.fn(), showDialog: vi.fn()
    });
    expect(result).toMatchObject({ ok: true, stub: false });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('A2 sends exact script/layout names and parameters to the confirmation boundary', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch;
    await executeRuntimeBehaviorAction(buttonObject({ type: 'runScript', scriptName: ' Script ', parameter: ' \n ' }), {
      layoutName: 'Layout', fmLayoutName: ' Exact Layout ', bridgeBaseUrl: 'http://127.0.0.1:9876/fm',
      openUrl: vi.fn(), navigateToLayout: vi.fn(), showDialog: vi.fn(), fetchFn
    });
    expect(JSON.parse(vi.mocked(fetchFn).mock.calls[0]![1]!.body as string)).toEqual({
      layout: ' Exact Layout ', scriptName: ' Script ', scriptParam: ' \n '
    });
  });

  it('normalizes bridge URL values', () => {
    expect(normalizeBridgeBaseUrl(undefined)).toBeUndefined();
    expect(normalizeBridgeBaseUrl('   ')).toBeUndefined();
    expect(normalizeBridgeBaseUrl('http://127.0.0.1:5173/fm///')).toBe('http://127.0.0.1:5173/fm');
  });
});
