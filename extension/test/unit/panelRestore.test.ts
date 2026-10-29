import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { LIVE_SERIALIZER_PANELS, RESTORABLE_PANELS, registerPanelRestoreGuards, renderReopenPage } from '../../src/webviews/common/panelRestore';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('restored webview tabs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps apostrophes literal while escaping other HTML characters', () => {
    const html = renderReopenPage(`A's <&>"`, `Run 'this' <&>"`);
    expect(html).toContain(`<title>A's &lt;&amp;&gt;&quot;</title>`);
    expect(html).toContain(`<strong>Run 'this' &lt;&amp;&gt;&quot;</strong>`);
  });

  it('every panel type the extension can open has a serializer (so a new panel cannot be added without one)', () => {
    const opened = new Set<string>();
    for (const file of sourceFiles(path.resolve(__dirname, '../../src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/createWebviewPanel\(\s*'([A-Za-z]+)'/g)) {
        opened.add(match[1] as string);
      }
    }
    const restorable = RESTORABLE_PANELS.map((panel) => panel.viewType);
    expect(opened.size).toBeGreaterThanOrEqual(10);
    expect([...opened].filter((viewType) => !restorable.includes(viewType) && !LIVE_SERIALIZER_PANELS.includes(viewType))).toEqual([]);
    expect([...restorable, ...LIVE_SERIALIZER_PANELS].filter((viewType) => !opened.has(viewType))).toEqual([]); // and none for a type that does not exist
    // The two mechanisms are alternatives: a panel type uses one of them, never both.
    expect(restorable.filter((viewType) => LIVE_SERIALIZER_PANELS.includes(viewType))).toEqual([]);
  });

  it('registers one serializer per view type, and each restored tab gets a static reopen page', async () => {
    const disposables = registerPanelRestoreGuards();
    expect(disposables).toHaveLength(RESTORABLE_PANELS.length);
    const calls = vi.mocked(vscode.window.registerWebviewPanelSerializer).mock.calls;
    expect(calls.map(([viewType]) => viewType).sort()).toEqual(RESTORABLE_PANELS.map((panel) => panel.viewType).sort());
    // The Query Builder has a serializer of its own, so it is not shown the reopen page.
    expect(calls.map(([viewType]) => viewType)).not.toContain('filemakerQueryBuilder');

    for (const [viewType, serializer] of calls) {
      const panel = { title: 'FileMaker Record Editor', webview: { html: '', cspSource: 'vscode-resource:' } };
      await serializer.deserializeWebviewPanel(panel as never, { restored: 'state', evil: '<script>x</script>' });
      expect(panel.webview.html, viewType).toContain('Close this tab and open it again');
      expect(panel.webview.html, viewType).toContain(RESTORABLE_PANELS.find((entry) => entry.viewType === viewType)?.reopenWith);
      // Nothing from the saved state, and nothing that can run.
      expect(panel.webview.html, viewType).not.toContain('evil');
      expect(panel.webview.html, viewType).not.toMatch(/<script/i);
    }
  });

  it('the page escapes the title, has a locked-down policy, and names a command that exists', () => {
    const html = renderReopenPage('<img src=x onerror=alert(1)>', 'FileMaker: Open Query Builder');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; style-src 'nonce-[A-Za-z0-9+/=_-]+';"/);

    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { commands: Array<{ title: string; category?: string }> };
    };
    const titles = new Set(manifest.contributes.commands.map((command) => `${command.category ?? 'FileMaker'}: ${command.title}`));
    expect(RESTORABLE_PANELS.filter((panel) => !titles.has(panel.reopenWith)).map((panel) => panel.reopenWith)).toEqual([]);
  });

  it('the manifest activates the extension before a saved tab is restored: onWebviewPanel for every panel type, and onStartupFinished is kept', () => {
    // VS Code does not generate onWebviewPanel events (there is no contribution point for a webview panel),
    // and a serializer registered at activation is too late if the extension has not activated when the tab is restored.
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { activationEvents: string[] };
    expect(manifest.activationEvents).toContain('onStartupFinished');
    expect(RESTORABLE_PANELS.filter((panel) => !manifest.activationEvents.includes(`onWebviewPanel:${panel.viewType}`)).map((panel) => panel.viewType)).toEqual([]);
    expect(LIVE_SERIALIZER_PANELS.filter((viewType) => !manifest.activationEvents.includes(`onWebviewPanel:${viewType}`))).toEqual([]);
    // And no event for a panel type that does not exist.
    const events = manifest.activationEvents.filter((event) => event.startsWith('onWebviewPanel:')).map((event) => event.slice('onWebviewPanel:'.length));
    const restorable = RESTORABLE_PANELS.map((panel) => panel.viewType);
    expect(events.filter((viewType) => !restorable.includes(viewType) && !LIVE_SERIALIZER_PANELS.includes(viewType))).toEqual([]);
    expect(new Set(manifest.activationEvents).size).toBe(manifest.activationEvents.length);
  });
});
