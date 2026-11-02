// Journey 9: offline mode (command and user/workspace settings), enterprise mode and roles, workspace trust changes with panels open.
import fs from 'node:fs';
import path from 'node:path';

import {
  answerPickers,
  connect,
  createProfile,
  ensureProfileCommands,
  openQueryBuilder
} from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J09 offline/enterprise/trust';
const wsSettings = (s) => path.join(s.ws, '.vscode', 'settings.json');
function setWorkspaceSettings(s, obj) {
  fs.mkdirSync(path.join(s.ws, '.vscode'), { recursive: true });
  if (obj === null) fs.rmSync(wsSettings(s), { force: true });
  else fs.writeFileSync(wsSettings(s), JSON.stringify(obj, null, 2));
}
async function tryCommand(s, title, pickers = ['Mock Quality', 'Products']) {
  await s.dismissToasts();
  await s.cmd(title);
  await answerPickers(s, pickers, { max: 2 });
  await s.page.waitForTimeout(1500);
  const modal = (await s.modalVisible()) ? await s.modalText() : '';
  if (modal) {
    await s.escape();
  }
  if (await s.pickerOpen()) await s.escape(2);
  return { toasts: await s.toasts(), modal, tabs: await s.editorTabs() };
}
async function waitForTrust(s, expected) {
  let actual;
  for (let i = 0; i < 40; i += 1) {
    actual = (await s.helper('ping')).trusted;
    if (actual === expected) return;
    await s.page.waitForTimeout(250);
  }
  assert(actual === expected, `workspace trust did not become ${expected}; actual=${actual}`);
}

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');
  await s.openFileMakerSidebar();
  const treeRows = async () => {
    await s.openFileMakerSidebar();
    await s.page.waitForTimeout(500);
    return s.allTreeRows();
  };

  // ---- offline mode ---------------------------------------------------------------------------
  await s.step(
    J,
    'Toggle Offline Mode (command)',
    'status/Explorer shows OFFLINE MODE; writes are disabled with a message; reads use the cache',
    async () => {
      await s.cmd('FileMaker: Toggle Offline Mode');
      await s.page.waitForTimeout(2000);
      const rows = await treeRows();
      const where = JSON.stringify(s.readSettings()['filemaker.offline.mode']);
      const sb = await s.statusBar();
      const create = await tryCommand(s, 'FileMaker: Create Record');
      const edit = await tryCommand(s, 'FileMaker: Delete Record');
      assert(
        rows.some((r) => /OFFLINE MODE/i.test(r)) || sb.some((x) => /offline/i.test(x)),
        `no offline indicator: ${rows.slice(0, 4).join(' | ')} / ${sb.join(' | ')}`
      );
      return `user settings.json offline.mode = ${where}; indicator: ${rows.filter((r) => /offline/i.test(r)).join(' | ') || sb.filter((x) => /offline/i.test(x)).join(' | ')}; Create Record -> ${JSON.stringify(create)}; Delete Record -> ${JSON.stringify(edit)}`;
    }
  );
  await s.step(
    J,
    'Query Builder while offline',
    'the user gets a clear message, not a hang',
    async () => {
      const wv = await openQueryBuilder(s, 'Customers');
      await wv.locator('#runButton').click();
      await s.page.waitForTimeout(3000);
      const st = (await wv.locator('#status').innerText()).replace(/\s+/g, ' ');
      const sum = (await wv.locator('#resultSummary').innerText()).replace(/\s+/g, ' ');
      const before = (await mock.log()).length;
      return `status: ${st} | summary: ${sum} | requests since toggling: see log (${before} total)`;
    }
  );
  await s.step(J, 'Toggle Offline Mode off', 'writes work again', async () => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Toggle Offline Mode');
    await s.page.waitForTimeout(2000);
    const rows = await treeRows();
    assert(!rows.some((r) => /OFFLINE MODE/i.test(r)), 'offline badge still there');
  });
  await s.step(
    J,
    'workspace settings cannot switch offline mode OFF (user-level scenario)',
    'user offline.mode=true stays on although the workspace says false',
    async () => {
      await s.setSetting('filemaker.offline.mode', true);
      setWorkspaceSettings(s, { 'filemaker.offline.mode': false });
      await s.page.waitForTimeout(2500);
      const rows = await treeRows();
      const on = rows.some((r) => /OFFLINE MODE/i.test(r));
      const r = await tryCommand(s, 'FileMaker: Create Record');
      assert(
        on,
        `offline badge missing although the user turned it on: ${rows.slice(0, 4).join(' | ')}`
      );
      return `Create Record -> ${JSON.stringify(r)}`;
    }
  );
  await s.step(
    J,
    'workspace settings may switch offline mode ON (stricter)',
    'user false + workspace true -> offline',
    async () => {
      await s.setSetting('filemaker.offline.mode', false);
      setWorkspaceSettings(s, { 'filemaker.offline.mode': true });
      await s.page.waitForTimeout(2500);
      const rows = await treeRows();
      return `offline badge shown: ${rows.some((r) => /OFFLINE MODE/i.test(r))}`;
    }
  );
  setWorkspaceSettings(s, null);
  await s.setSetting('filemaker.offline.mode', undefined);

  // ---- feature switches: a workspace may disable, never enable ---------------------------------------
  await s.step(
    J,
    'workspace turns recordEdit off: Create Record is refused',
    'message says record editing is disabled by settings',
    async () => {
      setWorkspaceSettings(s, { 'filemaker.features.recordEdit.enabled': false });
      await s.page.waitForTimeout(2000);
      const r = await tryCommand(s, 'FileMaker: Create Record');
      assert(
        r.toasts.some((t) => /disabled/i.test(t)) ||
          r.tabs.every((t) => !/Record Editor|Create/i.test(t)),
        JSON.stringify(r)
      );
      return JSON.stringify(r);
    }
  );
  await s.step(
    J,
    'user turns recordEdit off, workspace tries to turn it on',
    'still disabled',
    async () => {
      await s.setSetting('filemaker.features.recordEdit.enabled', false);
      setWorkspaceSettings(s, { 'filemaker.features.recordEdit.enabled': true });
      await s.page.waitForTimeout(2000);
      const r = await tryCommand(s, 'FileMaker: Create Record');
      assert(
        r.toasts.some((t) => /disabled/i.test(t)) ||
          r.tabs.every((t) => !/Record Editor|Create/i.test(t)),
        JSON.stringify(r)
      );
      return JSON.stringify(r);
    }
  );
  setWorkspaceSettings(s, null);
  await s.setSetting('filemaker.features.recordEdit.enabled', undefined);

  // ---- enterprise mode and roles -----------------------------------------------------------------
  await s.step(
    J,
    'enterprise mode, role viewer (user settings)',
    'viewer cannot delete, create, run batch updates or scripts; messages name the role',
    async () => {
      await s.setSetting('filemaker.enterprise.mode', true);
      await s.setSetting('filemaker.enterprise.role', 'viewer');
      await s.page.waitForTimeout(1500);
      const out = {};
      for (const c of [
        'FileMaker: Delete Record',
        'FileMaker: Create Record',
        'FileMaker: Open Script Runner'
      ])
        out[c] = await tryCommand(s, c, ['Mock Quality', 'Products']);
      await s.closeAllEditors();
      return JSON.stringify(out);
    }
  );
  await s.step(
    J,
    'workspace file tries to raise the role to admin',
    'the user role viewer is not overridden',
    async () => {
      fs.mkdirSync(path.join(s.ws, '.vscode'), { recursive: true });
      fs.writeFileSync(
        path.join(s.ws, '.vscode', 'filemaker.config.json'),
        JSON.stringify({ enterpriseMode: true, role: 'admin' })
      );
      await s.cmd('FileMaker: Reload Plugins').catch(() => {});
      await s.page.waitForTimeout(1500);
      const r = await tryCommand(s, 'FileMaker: Delete Record');
      const blocked = r.toasts.some((t) => /viewer|read-only|unavailable/i.test(t));
      assert(
        blocked,
        `the workspace config raised the role: no 'viewer' refusal was shown (a missing modal does not count as blocked): ${JSON.stringify(r)}`
      );
      return `Delete Record with admin in workspace config and viewer in user settings -> ${JSON.stringify(r)}`;
    }
  );
  fs.rmSync(path.join(s.ws, '.vscode', 'filemaker.config.json'), { force: true });
  await s.setSetting('filemaker.enterprise.role', 'developer');
  await s.setSetting('filemaker.enterprise.mode', undefined);
  await s.setSetting('filemaker.enterprise.role', undefined);

  // ---- workspace trust with panels open ------------------------------------------------------------
  await s.step(
    J,
    'restart with Workspace Trust enabled and trust the folder',
    'trusted; the Record Editor opens and loads a record',
    async () => {
      s.writeSettings({
        'security.workspace.trust.enabled': true,
        'security.workspace.trust.startupPrompt': 'always'
      });
      await s.closeAllEditors();
      await s.restart({ trusted: false });
      let text = 'no startup trust prompt appeared';
      try {
        text = await s.waitModal(12000);
        const buttons = await s.modalButtons();
        await s.modal(buttons.find((b) => /^yes/i.test(b)) ?? buttons[0]);
      } catch {
        /* fall through to the Workspace Trust editor */
      }
      await s.page.waitForTimeout(2000);
      let trusted = (await s.helper('ping')).trusted;
      if (trusted !== true) {
        await s.cmd('Workspaces: Manage Workspace Trust');
        await s.page.waitForTimeout(1500);
        await s.page
          .locator('.workspace-trust-editor .monaco-button', { hasText: /Trust Folder|Trust/ })
          .first()
          .click()
          .catch(() => {});
        await s.page.waitForTimeout(800);
        if (await s.modalVisible()) {
          const b = await s.modalButtons();
          await s.modal(b.find((x) => /^yes|trust/i.test(x) && !/don'?t/i.test(x)) ?? b[0]);
        }
        await s.page.waitForTimeout(2000);
        trusted = (await s.helper('ping')).trusted;
      }
      assert(trusted === true, 'could not trust the folder');
      await ensureProfileCommands(s);
      await connect(s, 'Mock Quality');
      const man = await mock.manifest();
      const rid = man.databases.Quality.tables.Products.conditions.clean[11];
      await s.closeAllEditors();
      await s.cmd('FileMaker: Open Record Editor');
      await answerPickers(s, ['Mock Quality', 'Products']);
      if (await s.pickerOpen()) await s.inputBox(String(rid), { timeout: 10000 });
      const wv = await s.webview('#recordIdInput');
      await wv
        .locator('#layoutSelect')
        .selectOption('Products')
        .catch(() => {});
      let how = 'loaded automatically';
      if (
        !(await wv
          .locator('#fieldEditor textarea')
          .first()
          .waitFor({ timeout: 10000 })
          .then(
            () => true,
            () => false
          ))
      ) {
        how = 'stuck on the loading skeleton; only the Load button loaded it';
        await wv.locator('#loadButton').click();
        await wv.locator('#fieldEditor textarea').first().waitFor({ timeout: 15000 });
      }
      ctx.trustRecord = rid;
      ctx.trustLoad = how;
      return `trust prompt: ${text.slice(0, 100)} | Record Editor ${ctx.trustLoad}`;
    }
  );
  await s.step(
    J,
    'withdraw trust while the Record Editor is open, then Save',
    'the open panel refuses to write (untrusted) and says why; no PATCH reaches the server',
    async () => {
      const wv = await s.webview('#recordIdInput');
      const field = wv.locator('#fieldEditor tr:has(td:text-is("Name")) textarea');
      await field.fill('edit after trust was withdrawn');
      await s.cmd('Workspaces: Manage Workspace Trust');
      await s.page.waitForTimeout(1500);
      const btn = s.page
        .locator('.workspace-trust-editor .workspace-trust-buttons .monaco-button', {
          hasText: /Don't Trust/i
        })
        .first();
      // A missed trust click must fail here, not silently turn every later Restricted Mode check
      // into a test of a still-trusted workspace. If trust came from a parent-folder entry VS Code
      // deliberately has no Don't Trust button; remove that entry to withdraw the inherited trust.
      if (await btn.count()) {
        await btn.click({ timeout: 10000 });
      } else {
        const removeTrustedFolder = s.page
          .locator('.workspace-trust-editor .workspace-trust-editor-remove-folder')
          .first();
        assert(
          (await removeTrustedFolder.count()) > 0,
          'neither a Don\'t Trust button nor a trusted-folder entry was available'
        );
        await removeTrustedFolder.click({ timeout: 10000 });
      }
      if (await s.modalVisible()) {
        const b = await s.modalButtons();
        await s.modal(b.find((x) => /don'?t trust|no/i.test(x)) ?? b[0]);
      }
      await waitForTrust(s, false);
      const patches0 = (await mock.log()).filter((l) => l.method === 'PATCH').length;
      // The trust editor is an overlay in current VS Code; close it before revealing the panel.
      await s.page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
      await s.page.waitForTimeout(400);
      await s.page
        .locator('.tabs-container .tab', { hasText: 'FileMaker Record Editor' })
        .first()
        .click();
      const editor = await s.webview('#recordIdInput');
      await editor.locator('#saveButton').click();
      let saveStatus = '';
      for (let i = 0; i < 40 && !/untrusted/i.test(saveStatus); i += 1) {
        await s.page.waitForTimeout(250);
        saveStatus = await editor.locator('#status').innerText();
      }
      assert(/untrusted/i.test(saveStatus), `Save was not refused: ${saveStatus}`);
      const r = await tryCommand(s, 'FileMaker: Delete Record');
      const patches1 = (await mock.log()).filter((l) => l.method === 'PATCH').length;
      assert(
        r.toasts.some((t) => /untrusted workspaces/i.test(t)),
        `Delete Record did not explain Restricted Mode: ${JSON.stringify(r)}`
      );
      assert(patches1 === patches0, `Save sent ${patches1 - patches0} PATCH request(s)`);
      return `trusted after withdrawing: false; Save -> ${saveStatus}; Delete Record -> ${JSON.stringify(r)}; PATCHes ${patches1 - patches0}`;
    }
  );
  await s.step(
    J,
    'untrusted workspace: write/batch/typegen commands',
    'each says it needs a trusted workspace',
    async () => {
      const out = {};
      const refused = (command) => {
        const visible = [...out[command].toasts, out[command].modal].join(' | ');
        assert(
          /trust|untrusted|restricted/i.test(visible),
          `${command} did not explain that it needs a trusted workspace: ${JSON.stringify(out[command])}`
        );
      };
      for (const c of [
        'FileMaker: Create Record',
        'FileMaker: Batch Update from CSV/JSON',
        'FileMaker: Generate Types for All Layouts',
        'FileMaker: Initialize FM Web Project'
      ]) {
        out[c] = await tryCommand(s, c, ['Mock Quality']);
        refused(c);
      }

      // AI context may intentionally go to extension global storage without trust. Configure an
      // in-workspace target to exercise the trust boundary, and confirm the multi-layout picker.
      await s.setSetting('filemaker.ai.contextPath', '.filemaker/ai-context.md');
      const aiCommand = 'FileMaker: Write AI Context';
      await s.dismissToasts();
      await s.cmd(aiCommand);
      await answerPickers(s, ['Mock Quality', 'Products'], { max: 2 });
      if (await s.pickerOpen()) await s.page.keyboard.press('Enter');
      await s.waitToast(/trust|untrusted|restricted/i, { timeout: 15000 });
      out[aiCommand] = { toasts: await s.toasts(), modal: '', tabs: await s.editorTabs() };
      refused(aiCommand);
      assert(
        !fs.existsSync(path.join(s.ws, '.filemaker', 'ai-context.md')),
        'AI context was written in an untrusted workspace'
      );
      await s.setSetting('filemaker.ai.contextPath', undefined);
      return JSON.stringify(out).slice(0, 900);
    }
  );
  s.writeSettings({ 'security.workspace.trust.enabled': false });
  await s.restart({ trusted: true });
}
