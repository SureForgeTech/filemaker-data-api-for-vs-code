import { standardFieldsCss } from '@fmweb/shared/dist/field-standards';
import * as vscode from 'vscode';

import { escapeHtml } from '../../utils/escapeHtml';
import { createNonce } from './csp';

/**
 * The webview panels the extension opens, and the command that reopens each.
 *
 * VS Code restores an open webview tab when a window reloads or restarts. Without a serializer for
 * its view type the tab comes back as an empty, dead panel: the page script is gone and nothing
 * listens to it. There are two ways out, and every panel type uses exactly one of them.
 *
 * The panels listed here are rebuilt from live connection state, so nothing about them can be
 * revived from saved state; instead the restored tab shows a short page that says so and names the
 * command that opens a working one.
 *
 * The panels listed in LIVE_SERIALIZER_PANELS keep their own page: their serializer puts the real
 * page back, and that page reads the snapshot it stored itself.
 */
export const RESTORABLE_PANELS: ReadonlyArray<{ viewType: string; reopenWith: string }> = [
  { viewType: 'filemakerConnectionWizard', reopenWith: 'FileMaker: Add Connection Profile' },
  { viewType: 'filemakerRecordViewer', reopenWith: 'FileMaker: Open Record Viewer' },
  { viewType: 'filemakerRecordEditor', reopenWith: 'FileMaker: Open Record Editor' },
  { viewType: 'filemakerScriptRunner', reopenWith: 'FileMaker: Open Script Runner' },
  { viewType: 'filemakerLayoutMode', reopenWith: 'FileMaker: Open FM Web Layout Mode' },
  { viewType: 'filemakerSchemaDiff', reopenWith: 'FileMaker: Diff Schema Snapshots' },
  { viewType: 'filemakerEnvironmentCompare', reopenWith: 'FileMaker: Compare Environments' },
  { viewType: 'filemakerDiagnosticsDashboard', reopenWith: 'FileMaker: Open Diagnostics Dashboard' },
  { viewType: 'filemakerEffectiveSettings', reopenWith: 'FileMaker: Show Effective Settings' }
];

/**
 * View types restored by a real serializer that rebuilds the panel so the page re-runs and reads
 * its saved vscode.getState() snapshot, instead of the static reopen page. Every view type the
 * extension opens must appear in exactly one of RESTORABLE_PANELS or LIVE_SERIALIZER_PANELS.
 */
export const LIVE_SERIALIZER_PANELS: ReadonlyArray<string> = ['filemakerQueryBuilder'];

/** A static page: no script, nothing from the saved state. */
export function renderReopenPage(title: string, reopenWith: string): string {
  const nonce = createNonce();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';" />
<title>${escapeHtml(title, false)}</title>
<style nonce="${nonce}">${standardFieldsCss(true)}</style></head>
<body class="fm-page">
<h1>${escapeHtml(title, false)}</h1>
<p>This panel was closed when VS Code reloaded, so it has nothing to show. Close this tab and open it again: run <strong>${escapeHtml(reopenWith, false)}</strong> from the Command Palette.</p>
</body></html>`;
}

/** Registers a serializer for every panel type, so a restored tab shows the reopen page instead of staying dead. */
export function registerPanelRestoreGuards(): vscode.Disposable[] {
  return RESTORABLE_PANELS.map(({ viewType, reopenWith }) =>
    vscode.window.registerWebviewPanelSerializer(viewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
        panel.webview.html = renderReopenPage(panel.title || 'FileMaker', reopenWith);
      }
    })
  );
}
