import { standardFieldsCss } from '@fmweb/shared/dist/field-standards';
import { lstat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { escapeHtml } from '../utils/escapeHtml';
import { isRoleName } from '../enterprise/roles';
import { readAiSettings, isExternalServerEnabled } from '../ai/aiSettings';
import type { RoleGuard } from '../enterprise/roleGuard';
import type { SettingsService } from '../services/settingsService';
import { buildWebviewCsp, createNonce } from '../webviews/common/csp';
import { inspectRestrictedSetting, readRestrictedSetting, readMaxRetries, readPerformanceMode } from '../utils/policySetting';
import { isFormulaNeutralizationOn, readUserScopeString } from '../utils/userScopeSetting';
import {
  EMPTY_NOTICE_STATE,
  MAX_SETTINGS_FILE_BYTES,
  POLICY_SETTINGS,
  explainSetting,
  fmt,
  noticeMessage,
  parseFilemakerSettings,
  pickNotices,
  type Explanation,
  type NoticeState,
  type PolicySetting
} from './settingPolicy';

export const SHOW_EFFECTIVE_SETTINGS = 'filemakerDataApiTools.showEffectiveSettings';
const NOTICE_STATE_KEY = 'filemaker.settingsNoticeState';
const OPEN_VIEW = 'Open Effective Settings';
const MUTE = "Don't show again for this workspace";

export interface Dependencies {
  context: vscode.ExtensionContext;
  roleGuard: RoleGuard;
  settingsService: SettingsService;
}

export type FileRead =
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string }
  | { status: 'ok'; values: Record<string, unknown> };

/**
 * Reads the `filemaker.*` entries of a settings file for the one purpose `inspect()` cannot serve:
 * VS Code hides application-scope keys that a workspace sets. It is bounded (size cap, a regular
 * file, nothing reached through a link) and never throws; a file it cannot read is reported.
 */
export async function readSettingsFile(file: string, boundary: string, section?: string): Promise<FileRead> {
  try {
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable', reason: 'cannot be opened' };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { status: 'unreadable', reason: 'is a link or not a regular file' };
    }
    if (stat.size > MAX_SETTINGS_FILE_BYTES) {
      return { status: 'unreadable', reason: 'is too large' };
    }
    const [realFile, realBoundary] = await Promise.all([realpath(file), realpath(boundary)]);
    if (!realFile.startsWith(realBoundary + path.sep)) {
      return { status: 'unreadable', reason: 'is outside the folder' };
    }
    const parsed = parseFilemakerSettings(await readFile(realFile, 'utf8'), section);
    return parsed.ok ? { status: 'ok', values: parsed.values } : { status: 'unreadable', reason: 'is not valid JSON' };
  } catch {
    return { status: 'unreadable', reason: 'cannot be read' };
  }
}

export interface WorkspaceFiles {
  values: Record<string, unknown>;
  /** Files that exist but could not be read, by short name. */
  unreadable: string[];
  multiRoot: boolean;
  /** Settings files were not read because the workspace is not trusted. */
  skippedUntrusted: boolean;
}

/** Folder `.vscode/settings.json` and the `.code-workspace` file, only in a trusted workspace. */
export async function readWorkspaceFiles(): Promise<WorkspaceFiles> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const result: WorkspaceFiles = {
    values: {},
    unreadable: [],
    multiRoot: folders.length > 1,
    skippedUntrusted: !vscode.workspace.isTrusted
  };
  if (result.skippedUntrusted) {
    return result;
  }
  const take = (read: FileRead, label: string): void => {
    if (read.status === 'unreadable') {
      result.unreadable.push(`${label} ${read.reason}`);
    } else if (read.status === 'ok') {
      for (const [key, value] of Object.entries(read.values)) {
        if (!(key in result.values)) {
          result.values[key] = value;
        }
      }
    }
  };
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile?.scheme === 'file' && workspaceFile.fsPath.endsWith('.code-workspace')) {
    take(await readSettingsFile(workspaceFile.fsPath, path.dirname(workspaceFile.fsPath), 'settings'), 'The .code-workspace file');
  }
  for (const folder of folders) {
    take(await readSettingsFile(path.join(folder.uri.fsPath, '.vscode', 'settings.json'), folder.uri.fsPath), '.vscode/settings.json');
  }
  return result;
}

function effectiveValue(
  setting: PolicySetting,
  config: vscode.WorkspaceConfiguration,
  inspected: ReturnType<vscode.WorkspaceConfiguration['inspect']>,
  deps: Dependencies,
  enterpriseFile: ReturnType<RoleGuard['getEnterpriseFileSettings']>
): unknown {
  const fallback = inspected?.defaultValue;
  const ai = (): ReturnType<typeof readAiSettings> => readAiSettings(config);
  switch (setting.key) {
    case 'connect.maxRetries':
      return readMaxRetries(config);
    case 'performance.mode':
      return readPerformanceMode(config);
    case 'enterprise.mode':
      return readRestrictedSetting(config, setting.key, false, true) || enterpriseFile.enterpriseMode === true;
    case 'enterprise.role':
      return deps.roleGuard.getRole();
    case 'ai.hiddenFields':
      return ai().hiddenFields;
    case 'ai.enabled':
      return ai().enabled;
    case 'ai.allowWrites':
      return ai().allowWrites;
    case 'ai.allowScripts':
      return ai().allowScripts;
    case 'ai.scriptAllowlist':
      return ai().scriptAllowlist;
    case 'ai.readableLayouts':
      return ai().readableLayouts;
    case 'ai.connection':
      return ai().connection ?? fallback;
    case 'ai.contextPath':
      return readUserScopeString(config, 'ai.contextPath') ?? fallback;
    case 'ai.externalServer.enabled':
      return isExternalServerEnabled(config);
    case 'export.neutralizeFormulas':
      return isFormulaNeutralizationOn(config);
    case 'secrets.fallback':
      return deps.settingsService.getSecretsFallbackMode();
    case 'savedQueries.scope':
      return deps.settingsService.getSavedQueriesScope();
    case 'typegen.outputDir':
      return deps.settingsService.getTypegenOutputDir();
    case 'schema.snapshots.storage':
      return deps.settingsService.getSchemaSnapshotsStorage();
    case 'batch.maxRecords':
      return deps.settingsService.getBatchMaxRecords();
    case 'batch.concurrency':
      return deps.settingsService.getBatchConcurrency();
    case 'batch.dryRunDefault':
      return deps.settingsService.getBatchDryRunDefault();
    default:
  }
  if (setting.kind === 'stricter-bool') {
    return readRestrictedSetting(config, setting.key, fallback === true, setting.restrictedValue === true);
  }
  return config.get(setting.key, fallback);
}

export interface Collected {
  rows: Explanation[];
  notes: string[];
}

/** Every policy-relevant setting with its explanation, computed from the readers that enforce it. */
export async function collectExplanations(deps: Dependencies): Promise<Collected> {
  const config = vscode.workspace.getConfiguration('filemaker');
  const manifest = deps.context.extension.packageJSON as {
    capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: string[] } };
  };
  const restricted = new Set(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []);
  const files = await readWorkspaceFiles();
  const enterpriseFile = deps.roleGuard.getEnterpriseFileSettings();
  const trusted = vscode.workspace.isTrusted;

  const rows = POLICY_SETTINGS.map((setting) => {
    const inspected = config.inspect(setting.key);
    const enterpriseValue =
      setting.key === 'enterprise.mode'
        ? enterpriseFile.enterpriseMode
        : setting.key === 'enterprise.role'
          ? enterpriseFile.role
          : undefined;
    const reading =
      setting.kind === 'stricter-bool' && setting.key !== 'enterprise.mode'
        ? inspectRestrictedSetting(config, setting.key, inspected?.defaultValue === true, setting.restrictedValue === true)
        : setting.key === 'enterprise.mode'
          ? inspectRestrictedSetting(config, setting.key, false, true)
          : undefined;
    return explainSetting({
      setting,
      values: {
        default: inspected?.defaultValue,
        user: inspected?.globalValue,
        workspace: inspected?.workspaceValue,
        workspaceFolder: inspected?.workspaceFolderValue,
        // Only application-scope keys are hidden from inspect(); every other kind trusts inspect().
        workspaceFile: setting.kind === 'user-only' ? files.values[setting.key] : undefined,
        enterpriseFile: isRoleName(enterpriseValue) || typeof enterpriseValue === 'boolean' ? enterpriseValue : undefined
      },
      effective: effectiveValue(setting, config, inspected, deps, enterpriseFile),
      trusted,
      restrictedInUntrusted: restricted.has(`filemaker.${setting.key}`),
      reading
    });
  });

  const notes: string[] = [];
  readAiSettings(config, ({ scope, kind, count }) => {
    const problem = kind === 'value-ignored'
      ? 'the value is not a list and was ignored; use an array of exact field names, for example ["SSN", "Password"]'
      : kind === 'string-as-name'
        ? 'the value is a string, so it still hides one exact field name (commas are not separators); use an array of exact field names, for example ["SSN", "Password"]'
        : `${count} non-text entries were ignored; valid names in the array still hide`;
    notes.push(`filemaker.ai.hiddenFields (${scope}): ${problem}.`);
  });
  if (!trusted) {
    notes.push('This workspace is in Restricted Mode: VS Code hides workspace values for the restricted settings, and the extension does not read the workspace settings files, so a workspace value for a User-only setting cannot be checked until you trust it.');
  }
  if (files.multiRoot) {
    notes.push("This is a multi-root workspace. A folder's .vscode/settings.json applies only to files in that folder; these settings are window-wide, so values from folder files are not used for them (the .code-workspace file is).");
  }
  for (const problem of files.unreadable) {
    notes.push(`Could not read a settings file (${problem}), so User-only settings it may hold are not checked.`);
  }
  notes.push('Application-scope (User-only) settings in a workspace are read from the .code-workspace file and, in a single-folder workspace, from .vscode/settings.json.');
  return { rows, notes };
}

const show = (value: unknown): string => (value === undefined ? '' : fmt(value, 200));

export function renderEffectiveSettingsHtml(
  collected: Collected,
  csp: string,
  nonce: string,
  asOf = new Date().toLocaleTimeString()
): string {
  const body = collected.rows
    .map((row) => {
      const key = escapeHtml(row.key);
      const buttons =
        `<button class="secondary" data-open="user" data-key="${key}">Open User Settings</button>` +
        (row.workspaceMeaningful
          ? `<button class="secondary" data-open="workspace" data-key="${key}">Open Workspace Settings</button>`
          : '');
      const note =
        (row.reason ? `<div class="${row.ignored ? 'ignored' : 'muted'}">${escapeHtml(row.reason)}</div>` : '') +
        (row.note ? `<div class="muted">${escapeHtml(row.note)}</div>` : '');
      return (
        `<tr><td data-label="Setting"><code>${key}</code></td>` +
        `<td data-label="In effect"><code>${escapeHtml(show(row.effective))}</code></td>` +
        `<td data-label="Comes from">${escapeHtml(row.source)}</td>` +
        `<td data-label="User value"><code>${escapeHtml(show(row.userValue))}</code></td>` +
        `<td data-label="Workspace value"><code>${escapeHtml(show(row.workspaceValue))}</code></td>` +
        `<td data-label="Notes">${note}${buttons}</td></tr>`
      );
    })
    .join('\n');
  const notes = collected.notes.map((text) => `<li>${escapeHtml(text)}</li>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>FileMaker Effective Settings</title>
<style nonce="${nonce}">${standardFieldsCss(true)}</style>
<style nonce="${nonce}">
  table { table-layout: fixed; }
  th:last-child { width: 240px; }
  th, td { overflow-wrap: anywhere; word-break: break-word; }
  code { white-space: pre-wrap; overflow-wrap: anywhere; }
  .ignored { color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); background: var(--vscode-inputValidation-warningBackground, #fff4ce); margin-bottom: 4px; }
  button { margin: 2px 4px 2px 0; }
  button[data-open] { white-space: nowrap; word-break: normal; overflow-wrap: normal; }
  .muted { color: color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground, #333333)) 75%, var(--vscode-foreground, #333333)); margin-bottom: 4px; }
  @media (max-width: 640px) {
    table, thead, tbody, tr, td { display: block; width: 100%; }
    thead { display: none; }
    tr { margin-bottom: 10px; border: 1px solid var(--vscode-panel-border, #8884); }
    td { border: none; border-bottom: 1px solid var(--vscode-panel-border, #8884); }
    td::before { content: attr(data-label) ": "; font-weight: 600; }
  }
</style></head>
<body>
<main class="fm-page">
<h1>Effective settings</h1>
<div class="fm-panel">
<p class="muted">What is in effect, where it comes from, and why a workspace value is ignored. Read-only snapshot taken at ${escapeHtml(asOf)}; it refreshes when settings change. <button id="refresh">Refresh</button></p>
<ul class="muted">${notes}</ul>
<table><thead><tr><th>Setting</th><th>In effect</th><th>Comes from</th><th>User value</th><th>Workspace value</th><th>Notes</th></tr></thead>
<tbody>
${body}
</tbody></table>
</div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const el = event.target.closest('button');
    if (!el) { return; }
    if (el.id === 'refresh') { vscode.postMessage({ type: 'refresh' }); return; }
    if (el.dataset.open) { vscode.postMessage({ type: 'open', target: el.dataset.open, key: el.dataset.key }); }
  });
</script>
</body></html>`;
}

/** The commands that open the Settings editor on the User or Workspace tab (VS Code 1.142 checked). */
export async function openSettingsTab(target: 'user' | 'workspace', key: string): Promise<void> {
  await vscode.commands.executeCommand(
    target === 'user' ? 'workbench.action.openGlobalSettings' : 'workbench.action.openWorkspaceSettings',
    { query: `@id:${key}` }
  );
}

/** Handles a message from the view. Anything but a known setting id and a known tab is dropped. */
export function handlePanelMessage(message: unknown, refresh: () => void): void {
  if (!message || typeof message !== 'object') {
    return;
  }
  const data = message as { type?: unknown; target?: unknown; key?: unknown };
  if (data.type === 'refresh') {
    refresh();
    return;
  }
  const known = POLICY_SETTINGS.some((setting) => `filemaker.${setting.key}` === data.key);
  if (data.type === 'open' && (data.target === 'user' || data.target === 'workspace') && known) {
    void openSettingsTab(data.target, data.key as string);
  }
}

let panel: vscode.WebviewPanel | undefined;

async function renderPanel(deps: Dependencies): Promise<void> {
  if (!panel) {
    return;
  }
  const collected = await collectExplanations(deps);
  const nonce = createNonce();
  const csp = buildWebviewCsp(panel.webview, { nonce, allowInlineStyleWithNonce: true });
  panel.webview.html = renderEffectiveSettingsHtml(collected, csp, nonce);
}

export async function showPanel(deps: Dependencies): Promise<void> {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('filemakerEffectiveSettings', 'FileMaker Effective Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: []
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      handlePanelMessage(message, () => void renderPanel(deps));
    });
  } else {
    panel.reveal();
  }
  await renderPanel(deps);
}

export async function announceIgnored(deps: Dependencies): Promise<void> {
  const state = deps.context.workspaceState.get<NoticeState>(NOTICE_STATE_KEY, EMPTY_NOTICE_STATE);
  const { show: toShow, next } = pickNotices((await collectExplanations(deps)).rows, state);
  if (toShow.length === 0) {
    return;
  }
  await deps.context.workspaceState.update(NOTICE_STATE_KEY, next);
  const choice = await vscode.window.showInformationMessage(noticeMessage(toShow), OPEN_VIEW, MUTE);
  if (choice === OPEN_VIEW) {
    await showPanel(deps);
  } else if (choice === MUTE) {
    await deps.context.workspaceState.update(NOTICE_STATE_KEY, { ...next, muted: true });
  }
}

export function registerEffectiveSettings(deps: Dependencies): vscode.Disposable[] {
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void renderPanel(deps).catch(() => undefined);
      void announceIgnored(deps).catch(() => undefined);
    }, 750);
    timer.unref();
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/settings.json');
  // The .code-workspace file can hold User-only settings too and sits outside the folders the
  // pattern above covers, so watch that one file as well.
  const workspaceFile = vscode.workspace.workspaceFile;
  const workspaceWatcher =
    workspaceFile?.scheme === 'file' && workspaceFile.fsPath.endsWith('.code-workspace')
      ? vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(path.dirname(workspaceFile.fsPath), path.basename(workspaceFile.fsPath))
        )
      : undefined;
  schedule();
  return [
    vscode.commands.registerCommand(SHOW_EFFECTIVE_SETTINGS, () => showPanel(deps)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('filemaker')) {
        schedule();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(schedule),
    watcher,
    watcher.onDidChange(schedule),
    watcher.onDidCreate(schedule),
    ...(workspaceWatcher
      ? [workspaceWatcher, workspaceWatcher.onDidChange(schedule), workspaceWatcher.onDidCreate(schedule), workspaceWatcher.onDidDelete(schedule)]
      : []),
    { dispose: () => clearTimeout(timer) }
  ];
}
