// Drives a real VS Code (downloaded by @vscode/test-electron) through Playwright's Electron support.
// Everything lives under one temp root (user data, extensions, HOME, workspace) so the user's own
// VS Code profile, extensions and keychain are never touched. `--use-mock-keychain` keeps Chromium's
// os_crypt from reading or writing the real macOS Keychain.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { cacheDir, ensurePrivateDir, prefetchVerified } from './vscode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const helperDir = path.resolve(here, '../helper-extension');

export function loadDeps() {
  try {
    const { _electron } = require('playwright-core');
    const tv = require('@vscode/test-electron');
    return {
      _electron,
      downloadAndUnzipVSCode: tv.downloadAndUnzipVSCode,
      resolveCli: tv.resolveCliArgsFromVSCodeExecutablePath
    };
  } catch (e) {
    return {
      error: `playwright-core or @vscode/test-electron is not installed (${e.message}). Run npm ci at the repository root.`
    };
  }
}

export async function getVSCode({ version = process.env.E2E_VSCODE_VERSION ?? 'stable' } = {}) {
  const deps = loadDeps();
  if (deps.error) throw new Error(deps.error);
  const cachePath = ensurePrivateDir(cacheDir());
  const check = await prefetchVerified(cachePath, version).catch((e) => {
    if (/sha256 mismatch/.test(e.message)) throw e; // never fall back after a bad checksum
    return { verified: false, note: `independent check unavailable (${e.message})` };
  });
  const exe = await deps.downloadAndUnzipVSCode({ version, cachePath });
  const [cli] = deps.resolveCli(exe);
  return { exe, cli, deps, cachePath, integrity: check.note };
}

/**
 * The environment passed to VS Code, the mock, the shim and helper processes: an allowlist, so tokens and
 * cloud credentials in the caller's shell (GH_TOKEN, AWS_*, ANTHROPIC_*, ...) never reach them.
 */
const ENV_ALLOW = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  '__CF_USER_TEXT_ENCODING'
];
export const safeEnv = (extra = {}) => {
  const out = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) out[k] = process.env[k];
  return { ...out, ...extra };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let assertCalls = 0;
/** Every journey assertion goes through here; `step` uses the counter to spot steps that assert nothing. */
/** For a check that throws by itself (a wait that times out, a judge helper): count it as an assertion. */
export const markAsserted = () => {
  assertCalls += 1;
};
export const assert = (cond, msg) => {
  assertCalls += 1;
  if (!cond) throw new Error(msg ?? 'assertion failed');
};

export class Session {
  constructor({ report, vscode, name = 'session' }) {
    this.report = report;
    this.vscode = vscode;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), `fm-e2e-${name}-`));
    this.ud = path.join(this.root, 'user-data');
    this.ex = path.join(this.root, 'extensions');
    this.home = path.join(this.root, 'home');
    this.ws = path.join(this.root, 'workspace');
    this.helperIO = path.join(this.root, 'helper-io');
    for (const d of [path.join(this.ud, 'User'), this.ex, this.home, this.ws, this.helperIO])
      fs.mkdirSync(d, { recursive: true });
    this.app = undefined;
    this.page = undefined;
    this.journey = 'setup';
    this.reqN = 0;
    this.baseSettings = {
      'window.dialogStyle': 'custom',
      'files.simpleDialog.enable': true,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'chat.commandCenter.enabled': false,
      'window.commandCenter': false,
      'editor.minimap.enabled': false,
      'workbench.enableExperiments': false,
      'workbench.welcomePage.walkthroughs.openOnInstall': false
    };
    this.writeSettings({});
  }

  // ---- settings and files ---------------------------------------------------------------
  get settingsPath() {
    return path.join(this.ud, 'User', 'settings.json');
  }
  readSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
    } catch {
      return {};
    }
  }
  writeSettings(patch, { replace = false } = {}) {
    const cur = replace ? {} : this.readSettings();
    fs.writeFileSync(
      this.settingsPath,
      JSON.stringify({ ...this.baseSettings, ...cur, ...patch }, null, 2)
    );
  }
  /** Change a user setting while VS Code runs and wait until the extension host sees it. */
  async setSetting(key, value) {
    const cur = this.readSettings();
    if (value === undefined) delete cur[key];
    else cur[key] = value;
    this.writeSettings(cur, { replace: true });
    if (this.app) {
      for (let i = 0; i < 40; i += 1) {
        const got = await this.helper('getConfig', { key }).catch(() => undefined);
        if (
          JSON.stringify(got?.value) === JSON.stringify(value) ||
          (value === undefined && got?.inspect?.globalValue === undefined)
        )
          return;
        await sleep(250);
      }
      throw new Error(`setting ${key} did not reach the extension host`);
    }
  }

  // ---- install / launch ------------------------------------------------------------------
  installVsix(vsix, { force = true } = {}) {
    const r = spawnSync(
      this.vscode.cli,
      [
        '--user-data-dir',
        this.ud,
        '--extensions-dir',
        this.ex,
        '--install-extension',
        vsix,
        ...(force ? ['--force'] : [])
      ],
      { encoding: 'utf8', env: safeEnv({ HOME: this.home }) }
    );
    if (r.status !== 0) throw new Error(`install failed: ${r.stdout}${r.stderr}`);
    return r.stdout.trim().split('\n').pop();
  }
  uninstall(id) {
    const r = spawnSync(
      this.vscode.cli,
      ['--user-data-dir', this.ud, '--extensions-dir', this.ex, '--uninstall-extension', id],
      { encoding: 'utf8', env: safeEnv({ HOME: this.home }) }
    );
    return `${r.stdout}${r.stderr}`.trim();
  }
  listExtensions() {
    return execFileSync(
      this.vscode.cli,
      [
        '--user-data-dir',
        this.ud,
        '--extensions-dir',
        this.ex,
        '--list-extensions',
        '--show-versions'
      ],
      { encoding: 'utf8', env: safeEnv({ HOME: this.home }) }
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  }

  async launch({
    folder = this.ws,
    trusted = true,
    helper = true,
    args = [],
    env = {},
    size = [1500, 950]
  } = {}) {
    const flags = [
      `--user-data-dir=${this.ud}`,
      `--extensions-dir=${this.ex}`,
      '--use-mock-keychain',
      '--skip-release-notes',
      '--disable-telemetry',
      '--disable-updates',
      '--no-sandbox'
    ];
    // The disposable profile holds invented E2E credentials only, so on Linux it may use VS Code's
    // plain text credential backend: a headless runner has no OS keyring, and VS Code would
    // otherwise open a modal keyring dialog on the first secret write, which blocks the extension
    // host and every later step with it. Only this ephemeral user-data directory is affected; the
    // macOS keychain protection and the extension's production SecretStorage stay untouched.
    if (process.platform === 'linux') flags.push('--password-store=basic');
    if (trusted) flags.push('--disable-workspace-trust');
    if (helper) flags.push(`--extensionDevelopmentPath=${helperDir}`);
    if (!this.welcome) flags.push('--skip-welcome');
    this.app = await this.vscode.deps._electron.launch({
      executablePath: this.vscode.exe,
      args: [...flags, ...args, ...(folder ? [folder] : [])],
      env: {
        ...safeEnv(),
        HOME: this.home,
        FM_E2E_HELPER_DIR: this.helperIO,
        ELECTRON_ENABLE_LOGGING: '',
        ...env
      },
      timeout: 90000
    });
    this.proc = this.app.process();
    this.helperOn = helper;
    this.page = await this.app.firstWindow();
    await this.page.waitForSelector('.monaco-workbench', { timeout: 90000 });
    await this.app
      .evaluate(({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ x: 40, y: 40, width: w, height: h });
      }, size)
      .catch(() => {});
    this.consoleErrors = [];
    this.page.on('pageerror', (e) => this.consoleErrors.push(String(e)));
    await this.dismissStartupOverlays();
    if (helper) await this.waitHelper();
    await sleep(1000);
    if (!this.keepRestoredEditors) await this.closeAllEditors().catch(() => {}); // VS Code restores webview tabs that nothing serves any more
  }
  /** VS Code 1.14x opens a "Welcome to VS Code: sign in to GitHub Copilot" overlay on first run. Never sign in. */
  async dismissStartupOverlays() {
    for (const label of ['Continue without Signing In', 'Get Started']) {
      const btn = this.page.getByText(label, { exact: true }).first();
      try {
        await btn.waitFor({ state: 'visible', timeout: label === 'Get Started' ? 4000 : 7000 });
        await btn.click();
        await sleep(600);
        this.sawSignInOverlay = true;
      } catch {
        /* not shown */
      }
    }
  }
  async waitHelper(timeoutMs = 60000) {
    const t0 = Date.now();
    for (;;) {
      try {
        return await this.helper('ping');
      } catch (e) {
        if (Date.now() - t0 > timeoutMs)
          throw new Error(`helper extension never answered: ${e.message}`);
        await sleep(500);
      }
    }
  }
  async close() {
    if (!this.app) return;
    const proc = this.proc;
    try {
      await Promise.race([this.app.close(), sleep(8000)]);
    } catch {
      /* ignore */
    }
    try {
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    this.app = undefined;
    this.page = undefined;
    await sleep(500);
  }
  async restart(opts) {
    await this.close();
    await this.launch(opts);
  }
  /** Copy VS Code logs (extension host, our output channel) next to the screenshots, then remove the temp root. */
  async dispose({ keepLogsTo } = {}) {
    await this.close();
    if (keepLogsTo) {
      try {
        fs.cpSync(path.join(this.ud, 'logs'), keepLogsTo, { recursive: true });
      } catch {
        /* none */
      }
    }
    // Any process still using the temp root (should be none) is killed before removal.
    spawnSync('pkill', ['-f', this.root]);
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  // ---- helper extension IPC --------------------------------------------------------------
  async helper(action, args = {}, timeoutMs = 20000) {
    const id = `r${Date.now()}-${(this.reqN += 1)}`;
    fs.mkdirSync(path.join(this.helperIO, 'requests'), { recursive: true });
    fs.writeFileSync(
      path.join(this.helperIO, 'requests', `${id}.json`),
      JSON.stringify({ action, ...args })
    );
    const out = path.join(this.helperIO, 'responses', `${id}.json`);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fs.existsSync(out)) {
        const res = JSON.parse(fs.readFileSync(out, 'utf8'));
        if (!res.ok) throw new Error(res.error);
        return res.data;
      }
      await sleep(100);
    }
    throw new Error(`helper ${action} timed out`);
  }

  // ---- UI primitives ----------------------------------------------------------------------
  async shot(label, journey = this.journey) {
    if (!this.page) return undefined;
    const file = this.report.nextShot(journey, label);
    try {
      await this.page.screenshot({ path: file, scale: 'css' });
    } catch {
      return undefined;
    }
    return file;
  }
  /** Declare steps (by name) that only record behaviour and assert nothing: they are reported as NOTE. */
  observeOnly(names) {
    this.observeNames = new Set([...(this.observeNames ?? []), ...names]);
  }
  /**
   * Runs one step. It PASSes only if it called `assert` (or returned an explicit { result }); a step that
   * asserts nothing is recorded as a NOTE with `unasserted: true`, never as a PASS. Pass
   * `{ observe: true }` for a step that only records what the product does (reported as NOTE).
   */
  async step(journey, step, expect, fn, opts = {}) {
    this.journey = journey;
    if (this.observeNames?.has(step)) opts = { ...opts, observe: true };
    let result = 'PASS';
    let detail = '';
    let explicit = false;
    const before = assertCalls;
    try {
      const out = await fn();
      if (out && typeof out === 'object' && out.result) {
        result = out.result;
        detail = out.detail ?? '';
        explicit = true;
      } else if (typeof out === 'string') detail = out;
    } catch (e) {
      result = 'FAIL';
      detail = String(e.message ?? e);
    }
    let unasserted = false;
    if (
      result === 'PASS' &&
      (opts.observe || (!explicit && !this.trustThrow && assertCalls === before))
    ) {
      result = 'NOTE';
      unasserted = !opts.observe;
      if (unasserted) detail = `no assertion in this step (observation only). ${detail}`;
    }
    const shot = await this.shot(step.slice(0, 40), journey);
    this.report.add({
      journey,
      step,
      expect,
      result,
      shot,
      detail,
      ...(unasserted ? { unasserted } : {})
    });
    return result === 'PASS';
  }
  note(journey, step, detail, result = 'NOTE') {
    this.report.add({ journey, step, expect: '', result, shot: undefined, detail });
  }
  notTestable(journey, step, why) {
    this.report.add({
      journey,
      step,
      expect: '',
      result: 'NOT-TESTABLE',
      shot: undefined,
      detail: why
    });
  }

  async pressKey(k) {
    await this.page.keyboard.press(k);
  }
  async pickerOpen() {
    return this.page
      .locator('.quick-input-box input')
      .first()
      .isVisible()
      .catch(() => false);
  }
  async quickInputOpen(timeout = 8000) {
    await this.page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout });
  }
  /** VS Code's own modal about U+2028/2029 in a document (our hostile data has them): not part of the test, click Ignore. */
  async autoDismiss() {
    try {
      if (await this.page.locator('.monaco-dialog-box').isVisible()) {
        const t = await this.page.locator('.monaco-dialog-box').innerText();
        if (/unusual line terminators/i.test(t)) {
          this.sawUnusualLineTerminators = true;
          await this.page
            .locator('.monaco-dialog-box .monaco-button', { hasText: 'Ignore' })
            .first()
            .click();
          await sleep(300);
        }
      }
    } catch {
      /* not there */
    }
  }
  /** Open the command palette, retrying when focus is stuck in a webview or an editor overlay. */
  async openPalette() {
    await this.page.bringToFront().catch(() => {}); // with two windows open only the focused one receives key events
    await this.autoDismiss();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      if (attempt >= 1) {
        await this.page.keyboard.press('Escape');
        await sleep(attempt >= 4 ? 1500 : 200);
        await this.page
          .locator('.part.editor, .monaco-workbench')
          .first()
          .click({ position: { x: 300, y: 300 }, force: true, timeout: 3000 })
          .catch(() => {});
        await this.page.bringToFront().catch(() => {});
      }
      await this.page.keyboard.press(attempt >= 2 ? 'Meta+Shift+P' : 'F1');
      try {
        await this.page
          .locator('.quick-input-box input')
          .first()
          .waitFor({ state: 'visible', timeout: 2500 });
        return;
      } catch {
        /* retry */
      }
    }
    throw new Error('the command palette did not open');
  }
  async cmd(title, { exact = true, wait = 400 } = {}) {
    await this.openPalette();
    await sleep(150);
    await this.page.keyboard.type(title, { delay: 4 });
    await sleep(wait);
    const rows = this.page.locator('.quick-input-list .monaco-list-row');
    await rows
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => {});
    const labels = (await rows.allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim());
    // The highlighted first row can be a "recently used" command that is not the one typed: click the exact match.
    let idx = labels.findIndex((l) =>
      l
        .toLowerCase()
        .replace(/^(recently used|other commands)\s*/, '')
        .startsWith(title.toLowerCase())
    );
    if (idx === -1) idx = labels.findIndex((l) => l.toLowerCase().includes(title.toLowerCase()));
    if (idx === -1) {
      if (exact) {
        await this.page.keyboard.press('Escape');
        throw new Error(
          `command not found in palette: ${title} (got: ${labels.slice(0, 3).join(' | ')})`
        );
      }
      await this.page.keyboard.press('Enter');
    } else await rows.nth(idx).click();
    await sleep(300);
  }
  /** Is the command listed in the palette right now? (when-clauses hide commands.) */
  async cmdListed(title) {
    await this.openPalette();
    await sleep(150);
    await this.page.keyboard.type(title, { delay: 4 });
    await sleep(500);
    const labels = (
      await this.page.locator('.quick-input-list .monaco-list-row').allInnerTexts()
    ).map((l) => l.replace(/\s+/g, ' ').toLowerCase());
    await this.page.keyboard.press('Escape');
    await sleep(200);
    return labels.some(
      (l) => l.includes(title.toLowerCase()) && !/no results|no matching|no commands/i.test(l)
    );
  }
  async waitCmdListed(title, timeoutMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.cmdListed(title)) return Date.now() - t0;
      await sleep(500);
    }
    return -1;
  }
  async reloadWindow() {
    await this.cmd('Developer: Reload Window');
    await sleep(2500);
    await this.page.waitForSelector('.monaco-workbench', { timeout: 60000 });
    await this.waitHelper().catch(() => {});
    await sleep(1500);
    if (!this.keepRestoredEditors) await this.closeAllEditors().catch(() => {});
  }
  async pickerItems() {
    await this.quickInputOpen();
    await sleep(300);
    return (await this.page.locator('.quick-input-list .monaco-list-row').allInnerTexts()).map(
      (s) => s.replace(/\s+/g, ' ').trim()
    );
  }
  /** Choose an item in the open quick pick by (part of) its label. */
  async pick(text, { timeout = 10000 } = {}) {
    await this.quickInputOpen(timeout);
    await sleep(300);
    const rows = this.page.locator('.quick-input-list .monaco-list-row');
    await rows.first().waitFor({ state: 'visible', timeout });
    const n = await rows.count();
    for (let i = 0; i < n; i += 1) {
      const t = (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
      if (t.toLowerCase().includes(text.toLowerCase())) {
        await rows.nth(i).click();
        await sleep(250);
        return t;
      }
    }
    // virtualised lists: filter by typing
    await this.page.keyboard.type(text, { delay: 4 });
    await sleep(400);
    const first = this.page.locator('.quick-input-list .monaco-list-row').first();
    const label = (await first.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!label.toLowerCase().includes(text.toLowerCase()))
      throw new Error(`picker has no "${text}" (first: ${label})`);
    await this.page.keyboard.press('Enter');
    await sleep(250);
    return label;
  }
  async inputBox(value, { submit = true, timeout = 10000, prompt } = {}) {
    await this.quickInputOpen(timeout);
    if (prompt)
      await this.page
        .locator('.quick-input-message', { hasText: prompt })
        .first()
        .waitFor({ state: 'visible', timeout });
    const box = this.page.locator('.quick-input-box input');
    await box.waitFor({ state: 'visible', timeout });
    await sleep(200);
    await box.fill(value);
    if (submit) {
      await this.page.keyboard.press('Enter');
      await sleep(250);
    }
  }
  async inputPlaceholder() {
    return this.page
      .locator('.quick-input-box input')
      .getAttribute('placeholder')
      .catch(() => '');
  }
  async quickInputTitle() {
    return (
      await this.page
        .locator('.quick-input-title')
        .innerText()
        .catch(() => '')
    ).trim();
  }
  async quickInputMessage() {
    return (
      await this.page
        .locator('.quick-input-message')
        .innerText()
        .catch(() => '')
    ).trim();
  }
  async escape(n = 1) {
    for (let i = 0; i < n; i += 1) {
      await this.page.keyboard.press('Escape');
      await sleep(120);
    }
  }

  async modalVisible() {
    return this.page
      .locator('.monaco-dialog-box')
      .isVisible()
      .catch(() => false);
  }
  async waitModal(timeout = 10000) {
    await this.page.locator('.monaco-dialog-box').waitFor({ state: 'visible', timeout });
    await sleep(200);
    return this.modalText();
  }
  async modalText() {
    return (
      await this.page
        .locator(
          '.monaco-dialog-box .dialog-message-text, .monaco-dialog-box .dialog-message-detail'
        )
        .allInnerTexts()
    )
      .join(' | ')
      .replace(/\s+/g, ' ');
  }
  async modalButtons() {
    return (
      await this.page.locator('.monaco-dialog-box .dialog-buttons .monaco-button').allInnerTexts()
    ).map((s) => s.trim());
  }
  async modal(button, { timeout = 10000 } = {}) {
    await this.waitModal(timeout);
    const b = this.page
      .locator('.monaco-dialog-box .dialog-buttons .monaco-button', { hasText: button })
      .first();
    await b.click();
    await sleep(300);
  }
  async toasts() {
    return (
      await this.page.locator('.notifications-toasts .notification-list-item').allInnerTexts()
    ).map((s) => s.replace(/\s+/g, ' ').trim());
  }
  async waitToast(re, { timeout = 15000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const all = await this.toasts();
      const hit = all.find((t) => re.test(t));
      if (hit) return hit;
      if (Date.now() - t0 > timeout)
        throw new Error(`no notification matching ${re}; saw: ${all.join(' || ') || '(none)'}`);
      await sleep(250);
    }
  }
  async clickToastButton(label) {
    await this.page
      .locator('.notifications-toasts .notification-list-item .monaco-button', { hasText: label })
      .first()
      .click();
    await sleep(300);
  }
  async dismissToasts() {
    await this.cmd('Notifications: Clear All Notifications').catch(() => {});
  }
  async statusBar() {
    return (await this.page.locator('.statusbar-item').allInnerTexts())
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  /** Click a status bar entry by its text. */
  async clickStatus(re) {
    await this.dismissToasts().catch(() => {}); // toasts sit over the right end of the status bar
    await sleep(400);
    const item = this.page.locator('.statusbar-item', { hasText: re }).first();
    await item
      .locator('a')
      .first()
      .click({ timeout: 10000 })
      .catch(async () => {
        await item.click({ timeout: 10000, force: true });
      });
    await sleep(500);
  }
  /** Tick several entries in an open multi-select quick pick (filter, click, clear), then confirm with Enter. */
  async pickMany(labels) {
    await this.quickInputOpen();
    const box = this.page.locator('.quick-input-box input').first();
    for (const label of labels) {
      await box.fill(label);
      await sleep(450);
      const rows = this.page.locator('.quick-input-list .monaco-list-row');
      const n = await rows.count();
      let hit = -1;
      for (let i = 0; i < n; i += 1) {
        const t = (await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim();
        if (t === label || t.startsWith(label)) {
          hit = i;
          break;
        }
      }
      if (hit === -1) throw new Error(`no item "${label}" in the picker`);
      await rows.nth(hit).click();
      await sleep(200);
    }
    await box.fill('');
    await sleep(300);
    await this.page.keyboard.press('Enter');
    await sleep(400);
  }
  async statusItem(re) {
    return (await this.statusBar()).find((s) => re.test(s));
  }
  async editorTabs() {
    return (await this.page.locator('.tabs-container .tab').allInnerTexts()).map((s) =>
      s.replace(/\s+/g, ' ').trim()
    );
  }
  async closeAllEditors() {
    await this.cmd('View: Close All Editors').catch(() => {});
    await sleep(400);
    // Untitled results documents are dirty: answer "Do you want to save?" with Don't Save.
    for (let i = 0; i < 4; i += 1) {
      if (!(await this.modalVisible())) break;
      const t = await this.modalText();
      const b = await this.modalButtons();
      if (/save/i.test(t) || b.some((x) => /don'?t save/i.test(x))) {
        await this.modal(b.find((x) => /don'?t save/i.test(x)) ?? b[0]);
        await sleep(300);
      } else break;
    }
  }
  async openFileQuick(relPath) {
    await this.page.keyboard.press('Meta+P');
    await this.quickInputOpen();
    await this.page.keyboard.type(relPath, { delay: 4 });
    await sleep(500);
    await this.page.keyboard.press('Enter');
    await sleep(700);
  }
  /** Text of the active text editor (Monaco keeps only visible lines in the DOM; fine for short files). */
  async activeEditorText() {
    return (
      await this.page
        .locator('.editor-instance .monaco-editor .view-lines')
        .first()
        .innerText()
        .catch(() => '')
    ).replace(/ /g, ' ');
  }

  async openFileMakerSidebar() {
    const a = this.page.locator('.activitybar a.action-label[aria-label^="FileMaker"]').first();
    if (!(await a.count())) return;
    const li = a.locator('xpath=ancestor::li[1]');
    const checked =
      (await li.getAttribute('aria-selected').catch(() => null)) === 'true' ||
      /checked/.test((await li.getAttribute('class').catch(() => '')) ?? '') ||
      (await a.getAttribute('aria-expanded').catch(() => null)) === 'true';
    const sidebarVisible = await this.page
      .locator('.part.sidebar')
      .isVisible()
      .catch(() => false);
    if (!(checked && sidebarVisible)) await a.click();
    await sleep(600);
  }
  /** Collect every row of a virtualised VS Code list by scrolling it from top to bottom. */
  async collectList(rowSel, hoverSel) {
    const seen = new Map();
    const box = await this.page.locator(hoverSel).first().boundingBox();
    if (!box) return [];
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i += 1) await this.page.mouse.wheel(0, -2000);
    await sleep(200);
    let stable = 0;
    for (let i = 0; i < 80 && stable < 3; i += 1) {
      const before = seen.size;
      for (const t of await this.page.locator(rowSel).allInnerTexts()) {
        const k = t.replace(/\s+/g, ' ').trim();
        if (k && !seen.has(k)) seen.set(k, seen.size);
      }
      stable = seen.size === before ? stable + 1 : 0;
      await this.page.mouse.wheel(0, 180);
      await sleep(120);
    }
    for (let i = 0; i < 12; i += 1) await this.page.mouse.wheel(0, -2000);
    return [...seen.keys()];
  }
  async allTreeRows() {
    return this.collectList('.pane-body .monaco-list-row', '.pane-body .monaco-list');
  }
  async allPickerItems() {
    return this.collectList('.quick-input-list .monaco-list-row', '.quick-input-list');
  }
  async treeRows() {
    return (await this.page.locator('.pane-body .monaco-list-row').allInnerTexts())
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  /** The webview content frame that contains `selector`. Webview editors nest two iframes; the inner one is fake.html. */
  /** innerText of the webview that is actually showing (not a hidden tab's), optionally the first one matching a selector. */
  async visibleWebviewText() {
    for (const f of this.page.frames()) {
      if (!/vscode-webview:\/\/[^/]+\/fake\.html/.test(f.url())) continue;
      try {
        if (
          await f.evaluate(
            () =>
              document.body &&
              document.body.getBoundingClientRect().width > 0 &&
              document.visibilityState !== 'hidden' &&
              document.body.offsetParent !== undefined &&
              !!document.body.innerText.trim()
          )
        )
          return { frame: f, text: await f.locator('body').innerText() };
      } catch {
        /* detached */
      }
    }
    return undefined;
  }
  async webview(selector, { timeout = 20000, visible = true } = {}) {
    const t0 = Date.now();
    for (;;) {
      for (const frame of this.page.frames()) {
        if (!/vscode-webview:\/\/[^/]+\/fake\.html/.test(frame.url())) continue;
        const loc = frame.locator(selector).first();
        try {
          if ((await loc.count()) && (!visible || (await loc.isVisible()))) return frame;
        } catch {
          /* detached */
        }
      }
      if (Date.now() - t0 > timeout) throw new Error(`no webview with ${selector}`);
      await sleep(300);
    }
  }
}
