// Reusable user flows built on Session primitives.
import { assert, markAsserted } from './session.mjs';
import fs from 'node:fs';
import path from 'node:path';

/** Create a direct-auth profile through the wizard (test, then save). Returns when the wizard says "saved". */
export async function createProfile(
  s,
  {
    name,
    url,
    database,
    username = 'tester',
    password = 'testpass1',
    allowSelfSigned = false,
    caBundlePath = ''
  }
) {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Add Connection Profile');
  const wv = await s.webview('#wizardForm');
  for (const [id, v] of Object.entries({
    profileName: name,
    serverUrl: url,
    database,
    username,
    password
  }))
    await wv.locator(`#${id}`).fill(v);
  if (caBundlePath || allowSelfSigned) {
    await wv.locator('#certificateOptions summary').click();
    if (caBundlePath) await wv.locator('#caBundlePath').fill(caBundlePath);
  }
  const t = await wizardTest(s, wv, { answer: allowSelfSigned ? /trust/i : undefined });
  if (!/uccess|onnect/i.test(t.status))
    throw new Error(`Test Connection failed: ${describeTest(t)}`);
  await wv.locator('#saveBtn').click();
  await wv.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 });
  await s.closeAllEditors();
}

/** FileMaker: Connect, choosing the profile by name if asked. */
export async function connect(s, name) {
  await s.cmd('FileMaker: Connect');
  await s.page.waitForTimeout(700);
  if (await s.pickerOpen()) await s.pick(name);
  const t = await s.waitToast(/onnected to/i, { timeout: 25000 }); // throws when there is no such toast
  markAsserted();
  return t;
}

/** Make sure palette commands that depend on filemaker.hasProfiles are offered (the context key is stale after a first save). */
export async function ensureProfileCommands(s) {
  if ((await s.waitCmdListed('FileMaker: Connect', 4000)) >= 0) return false;
  await s.reloadWindow();
  assert(
    (await s.waitCmdListed('FileMaker: Connect', 10000)) >= 0,
    'Connect is not offered even after a window reload'
  );
  return true;
}

/** Click a row in the FileMaker tree by its visible label. */
export async function treeRow(s, label) {
  const row = s.page.locator('.pane-body .monaco-list-row', { hasText: label }).first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  return row;
}
export async function expandTreeRow(s, label) {
  const row = await treeRow(s, label);
  const expanded = await row.getAttribute('aria-expanded');
  // A single click on a layout row opens the Query Builder, so use the twistie (or the Right arrow key).
  if (expanded !== 'true') await row.locator('.monaco-tl-twistie').first().click();
  await s.page.waitForTimeout(900);
}
export async function refreshExplorer(s) {
  const header = s.page.locator('.pane-header', { hasText: 'Connections' }).first();
  await header.hover();
  const btn = header
    .locator('.actions .codicon-refresh, .actions a[aria-label*="Refresh"]')
    .first();
  if (await btn.count()) await btn.click({ timeout: 5000 });
  else await s.helper('executeCommand', { command: 'filemakerDataApiTools.refreshExplorer' });
  await s.page.waitForTimeout(1500);
}

/** Answer any quick pick that is open by choosing the first matching label from the list (profile, layout...). */
export async function answerPickers(s, labels, { max = 4 } = {}) {
  for (let i = 0; i < max; i += 1) {
    await s.page.waitForTimeout(700);
    if (!(await s.pickerOpen())) return;
    const items = await s.pickerItems();
    if (!items.length) return; // an input box, not a pick list
    if (items[0] === '..') return; // the file dialog (its first row is the parent folder), not a pick list: the caller answers it
    let want = labels.find((l) => items.some((it) => it.toLowerCase().includes(l.toLowerCase())));
    if (!want && items.length >= 8) {
      // a long list is virtualised: the wanted entry may be below the fold, so filter by typing
      const title = await s.quickInputTitle().catch(() => '');
      want = /layout/i.test(title) ? labels[labels.length - 1] : labels[0];
    }
    if (!want) return;
    await s.pick(want);
  }
}

export async function openQueryBuilder(s, layout = 'Customers', profile = 'Mock Quality') {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Open Query Builder');
  await answerPickers(s, [profile, layout]);
  const wv = await s.webview('#runButton');
  await wv.locator('#runButton').waitFor({ state: 'visible', timeout: 15000 });
  return wv;
}

/** Clipboard text through the Electron main process (never the system pasteboard of another app). */
export async function readClipboard(s) {
  return s.app.evaluate(({ clipboard }) => clipboard.readText());
}
export async function writeClipboard(s, text) {
  return s.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/** Answer VS Code's "simple dialog" file picker (files.simpleDialog.enable) with an absolute path. */
export async function answerFileDialog(s, absPath, { timeout = 10000 } = {}) {
  await s.quickInputOpen(timeout);
  await s.page.waitForTimeout(400);
  const box = s.page.locator('.quick-input-box input').first();
  await box.fill(absPath);
  await s.page.waitForTimeout(300);
  await s.page.keyboard.press('Enter');
  await s.page.waitForTimeout(600);
  // overwrite confirmation, if any
  if (await s.modalVisible()) {
    const b = await s.modalButtons();
    await s.modal(b.find((x) => /replace|overwrite|yes/i.test(x)) ?? b[0]);
  }
}

/** Batch export prompts, including the CSV choice after the save dialog. */
export async function batchExport(s, layout, findJson, out) {
  fs.rmSync(out, { force: true });
  await s.closeAllEditors();
  await s.dismissToasts();
  await s.cmd('FileMaker: Batch Export (Find)');
  await answerPickers(s, ['Mock Quality', layout]);
  await s.inputBox(findJson, { timeout: 15000, prompt: /Find query JSON/ });
  await s.inputBox('', { timeout: 10000, prompt: /Sort JSON/ });
  await answerFileDialog(s, out, { timeout: 15000 });
  if (path.extname(out).toLowerCase() === '.csv') await s.pick('Standard CSV');
  await s.waitToast(/Started job/i, { timeout: 15000 });
  for (let i = 0; i < 60 && !fs.existsSync(out); i += 1) await s.page.waitForTimeout(500);
  if (!fs.existsSync(out)) {
    // A start toast says nothing about success. Preserve the actual job error/output path in the report.
    await s.cmd('FileMaker: Show Jobs');
    await s.pick(`Batch Export ${layout}`);
    await s.pick('View details');
    const { text } = await s.helper('activeDocumentText');
    throw new Error(`No export at ${out}. Job details: ${text}`);
  }
  markAsserted();
}

const wtext = async (wv, sel) =>
  (
    await wv
      .locator(sel)
      .first()
      .innerText()
      .catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .trim();

/** Click Test Connection in the wizard. A build with certificate pinning answers some failures with a "Trust this certificate" modal. */
export async function wizardTest(s, wv, { answer } = {}) {
  await wv.locator('#testBtn').click();
  let modal = null;
  for (let i = 0; i < 70; i += 1) {
    await s.page.waitForTimeout(500);
    if (await s.modalVisible()) {
      const mtext = await s.modalText();
      const mb = await s.modalButtons();
      modal = { text: mtext, buttons: mb };
      await s.shot('wizard-modal');
      if (answer) await s.modal(mb.find((b) => answer.test(b)) ?? mb[0]);
      else await s.modal(mb.find((b) => /cancel|no\b/i.test(b)) ?? mb[mb.length - 1]);
      await s.page.waitForTimeout(1500);
      if ((await s.modalVisible()) && answer) {
        const m2 = { text: await s.modalText(), buttons: await s.modalButtons() };
        modal.second = m2;
        await s.modal(m2.buttons.find((b) => answer.test(b)) ?? m2.buttons[0]);
        await s.page.waitForTimeout(1500);
      }
      break;
    }
    const st = await wtext(wv, '#status');
    if (st && !/Step \d of \d|Testing|Reaching/i.test(st)) break;
  }
  await s.page.waitForTimeout(1500);
  return { status: await wtext(wv, '#status'), modal };
}
export const describeTest = (t) =>
  `status: "${t.status}"${t.modal ? ` | modal: ${t.modal.text.replace(/\s+/g, ' ').slice(0, 700)} | buttons: ${t.modal.buttons.join(' / ')}${t.modal.second ? ` | second modal: ${t.modal.second.text.replace(/\s+/g, ' ').slice(0, 300)} / ${t.modal.second.buttons.join(' / ')}` : ''}` : ''}`;
