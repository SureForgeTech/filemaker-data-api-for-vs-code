// Journey 5: Record Editor: open, edit, save, concurrent-edit conflict + reload, create, validation error, delete.
import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J05 record editor';
const field = (wv, name) => wv.locator(`#fieldEditor tr:has(td:text-is("${name}")) .fm-field-control[aria-label]`);
const status = async (wv) => (await wv.locator('#status').innerText()).replace(/\s+/g, ' ').trim();

async function openEditor(s, recordId, layout = 'Products') {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Open Record Editor');
  await answerPickers(s, ['Mock Quality', layout]);
  // "Record ID (optional; leave blank to browse)" input box
  if (await s.pickerOpen()) await s.inputBox(String(recordId), { timeout: 10000 });
  const wv = await s.webview('#recordIdInput');
  await wv
    .locator('#layoutSelect')
    .selectOption(layout)
    .catch(() => {});
  if (!(await wv.locator('#fieldEditor .fm-field-control[aria-label]').count())) {
    await wv.locator('#recordIdInput').fill(String(recordId));
    await wv.locator('#loadButton').click();
  }
  await wv.locator('#fieldEditor .fm-field-control[aria-label]').first().waitFor({ timeout: 20000 });
  return wv;
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
  const data = mock.data('Quality');
  const man = await mock.manifest();
  const productId = man.databases.Quality.tables.Products.conditions.clean[0];
  let wv;

  await s.step(
    J,
    'open the editor on a record and load it',
    'the record id is loaded and every layout field appears as an editable row',
    async () => {
      wv = await openEditor(s, productId);
      const n = await wv.locator('#fieldEditor tbody tr').count();
      assert(n >= 5, `rows: ${n}`);
      return `${n} field rows`;
    }
  );
  await s.step(
    J,
    'compare Viewer and Editor field geometry',
    'unlimited Name text uses 96 px controls, 120 px fields and 136 px row pitch; Viewer Copy stays in the label',
    async () => {
      const geometry = (row) => {
        const control = row.querySelector('.fm-field-control[aria-label]');
        const box = control.getBoundingClientRect();
        const button = row.querySelector('button');
        return {
          field: row.getBoundingClientRect().height,
          control: box.height,
          pitch: row.getBoundingClientRect().height + parseFloat(getComputedStyle(row.parentElement).rowGap),
          readonly: control.readOnly,
          copyInLabel: !!button && row.querySelector('.fm-field-label').contains(button)
        };
      };
      const editor = await wv.locator('#fieldEditor tr:has(td:text-is("Name"))').evaluate(geometry);
      await s.closeAllEditors();
      await s.cmd('FileMaker: Open Record Viewer');
      await answerPickers(s, ['Mock Quality', 'Products']);
      if (await s.pickerOpen()) await s.inputBox(String(productId), { timeout: 10000 });
      const viewer = await s.webview('#fieldDataContainer', { visible: false });
      await viewer.locator('#recordIdInput').fill(String(productId));
      await viewer.locator('#loadButton').click();
      const row = viewer.locator('#fieldDataContainer tr:has(td:text-is("Name"))');
      await row.locator('textarea').waitFor({ timeout: 20000 });
      const viewed = await row.evaluate(geometry);
      // Restore the editor before assertions so a geometry failure cannot strand later steps.
      wv = await openEditor(s, productId);
      // The mock reports maxCharacters: 0 for Products/Name: unlimited text (PR #455).
      for (const [name, measured] of [['Editor', editor], ['Viewer', viewed]]) {
        assert(Math.abs(measured.control - 96) < 1, `${name} control: ${JSON.stringify(measured)}`);
        assert(Math.abs(measured.field - 120) < 1, `${name} field: ${JSON.stringify(measured)}`);
        assert(Math.abs(measured.pitch - 136) < 1, `${name} pitch: ${JSON.stringify(measured)}`);
      }
      assert(Math.abs(viewed.field - editor.field) < 1 && viewed.readonly && viewed.copyInLabel, JSON.stringify({ editor, viewed }));
      return JSON.stringify({ editor, viewed });
    }
  );
  await s.step(
    J,
    'edit a field, Validate, Preview Update JSON',
    'preview shows only the changed field',
    async () => {
      await field(wv, 'Name').fill('Edited in the UI');
      await wv.locator('#validateButton').click();
      await s.page.waitForTimeout(800);
      await wv.locator('#previewButton').click();
      await s.page.waitForTimeout(800);
      const prev = await wv.locator('#patchPreview').innerText();
      assert(
        prev.includes('Edited in the UI') && !prev.includes('Price'),
        `preview: ${prev.slice(0, 200)}`
      );
      return prev.replace(/\s+/g, ' ').slice(0, 200);
    }
  );
  await s.step(
    J,
    'Save: confirmation modal lists the changed field; confirm',
    'modal names the change and the record; after Save the server has the new value and modId+1',
    async () => {
      const before = await data.record('Products', productId);
      await wv.locator('#saveButton').click();
      const text = await s.waitModal(15000);
      assert(/Name/.test(text), `modal: ${text}`);
      await s.shot('save-confirm');
      await s.modal('Save');
      await s.page.waitForTimeout(2500);
      const after = await data.record('Products', productId);
      assert(after.fieldData.Name === 'Edited in the UI', `server value: ${after.fieldData.Name}`);
      assert(
        Number(after.modId) === Number(before.modId) + 1,
        `modId ${before.modId} -> ${after.modId}`
      );
      return `${text.slice(0, 140)} | modId ${before.modId} -> ${after.modId} | status: ${await status(wv)}`;
    }
  );
  await s.step(
    J,
    'decline the Save confirmation',
    'nothing is written; the draft stays',
    async () => {
      await field(wv, 'Name').fill('Should not be saved');
      const before = await data.record('Products', productId);
      await wv.locator('#saveButton').click();
      await s.modal('Cancel').catch(async () => {
        await s.escape();
      });
      await s.page.waitForTimeout(1200);
      const after = await data.record('Products', productId);
      assert(
        after.fieldData.Name === before.fieldData.Name && after.modId === before.modId,
        'server record changed'
      );
      assert((await field(wv, 'Name').inputValue()) === 'Should not be saved', 'draft was lost');
      return `status: ${await status(wv)}`;
    }
  );
  await s.step(
    J,
    'concurrent edit: another user saves first',
    'Save is refused (306): the conflict banner appears naming the record changed elsewhere, draft kept',
    async () => {
      await mock.admin('/__admin/concurrent-edit', {
        db: 'Quality',
        table: 'Products',
        recordId: productId,
        fieldData: { Description: 'changed by someone else' }
      });
      await field(wv, 'Name').fill('My conflicting edit');
      await wv.locator('#saveButton').click();
      await s.modal('Save', { timeout: 15000 });
      await wv.locator('#conflictBanner:not(.hidden)').waitFor({ timeout: 15000 });
      const text = (await wv.locator('#conflictText').innerText()).replace(/\s+/g, ' ');
      assert(
        (await field(wv, 'Name').inputValue()) === 'My conflicting edit',
        'draft was discarded'
      );
      const server = await data.record('Products', productId);
      assert(
        server.fieldData.Name !== 'My conflicting edit',
        'conflicting edit was written anyway'
      );
      return text;
    }
  );
  await s.step(
    J,
    'Reload after conflict',
    "latest record is loaded; the other user's change is visible",
    async () => {
      await wv.locator('#reloadAfterConflictButton').click();
      await s.page.waitForTimeout(2000);
      assert(
        (await field(wv, 'Description').inputValue()) === 'changed by someone else',
        `Description: ${await field(wv, 'Description').inputValue()}`
      );
      await field(wv, 'Name').fill('Edit after reload');
      await wv.locator('#saveButton').click();
      await s.modal('Save', { timeout: 15000 });
      await s.page.waitForTimeout(2500);
      assert(
        (await data.record('Products', productId)).fieldData.Name === 'Edit after reload',
        'save after reload failed'
      );
    }
  );
  await s.step(
    J,
    'record deleted by someone else, then Save',
    'a clear "record is missing" message (101), no success claim',
    async () => {
      const tmp = (
        await data.call('POST', '/layouts/Products/records', {
          fieldData: { SKU: 'TMP-DEL', Name: 'temp' }
        })
      ).body.response.recordId;
      wv = await openEditor(s, tmp);
      await mock.admin('/__admin/concurrent-delete', {
        db: 'Quality',
        table: 'Products',
        recordId: tmp
      });
      await field(wv, 'Name').fill('edit of a vanished record');
      await wv.locator('#saveButton').click();
      await s.modal('Save', { timeout: 15000 });
      await s.page.waitForTimeout(2500);
      const st = await status(wv);
      assert(
        !/saved|success/i.test(st) || /not|fail|missing|101/i.test(st),
        `status claims success: ${st}`
      );
      return st;
    }
  );
  await s.step(
    J,
    'Open Record Editor again for another record while the panel is already open',
    'the existing panel loads the new record (no stuck loading skeleton)',
    async () => {
      const other = man.databases.Quality.tables.Products.conditions.clean[14];
      await s.cmd('FileMaker: Open Record Editor');
      await answerPickers(s, ['Mock Quality', 'Products']);
      if (await s.pickerOpen()) await s.inputBox(String(other), { timeout: 10000 });
      const w = await s.webview('#recordIdInput');
      await s.page.waitForTimeout(4000);
      const rows = await w.locator('#fieldEditor tbody tr').count();
      const rid = await w.locator('#recordIdInput').inputValue();
      if (rows === 0)
        throw new Error(
          `panel stays on its loading skeleton after reopening for record ${other} (record id box shows ${rid}); Load button needed`
        );
      if (rid !== String(other))
        throw new Error(`panel shows record id ${rid} instead of ${other}`);
      return `${rows} field rows for record ${rid}`;
    }
  );
  await s.step(
    J,
    'Create Record: fill and create',
    'modal "Create a new record"; toast with the new id; record exists with the entered values',
    async () => {
      await s.closeAllEditors();
      const before = await data.count('Products');
      await s.cmd('FileMaker: Create Record');
      await answerPickers(s, ['Mock Quality', 'Products']);
      wv = await s.webview('#fieldEditor');
      await field(wv, 'SKU').waitFor({ timeout: 15000 });
      await field(wv, 'SKU').fill('E2E-NEW-1');
      await field(wv, 'Name').fill('Created from the UI');
      await field(wv, 'Category').selectOption('Hardware');
      await wv.getByRole('button', { name: 'Create Record' }).click();
      const text = await s.waitModal(15000);
      assert(/Create a new record/.test(text), text);
      await s.modal('Create');
      const t = await s.waitToast(/Record created/i, { timeout: 15000 });
      const after = await data.count('Products');
      assert(after === before + 1, `count ${before} -> ${after}`);
      const found = await data.find('Products', [{ SKU: '==E2E-NEW-1' }]);
      assert(found.response.data[0].fieldData.Name === 'Created from the UI', 'values not stored');
      return `${t} | ${text.slice(0, 100)}`;
    }
  );
  await s.step(
    J,
    'Create with a value the server rejects (value list, error 506)',
    'the server message reaches the user; no success toast',
    async () => {
      await s.dismissToasts();
      wv = await s.webview('#fieldEditor');
      await field(wv, 'SKU').fill('E2E-NEW-2');
      // The menu prevents invalid choices; inject one to exercise server-side error 506.
      await field(wv, 'Category').evaluate((select) => {
        select.add(new Option('Bogus', 'Bogus'));
      });
      await field(wv, 'Category').selectOption('Bogus');
      await wv.getByRole('button', { name: 'Create Record' }).click();
      await s.modal('Create', { timeout: 15000 });
      await s.page.waitForTimeout(2500);
      const st = await status(wv);
      const toasts = await s.toasts();
      assert(
        !toasts.some((t) => /Record created/.test(t)),
        `success toast shown: ${toasts.join(' | ')}`
      );
      assert(/506|value list|not a member/i.test(st), `status: ${st}`);
      return st;
    }
  );
  await s.step(
    J,
    'Delete Record: decline, then confirm',
    'Cancel keeps the record; Delete removes it and says so',
    async () => {
      await s.closeAllEditors();
      const rec = (
        await data.call('POST', '/layouts/Products/records', {
          fieldData: { SKU: 'TMP-DEL2', Name: 'delete me' }
        })
      ).body.response.recordId;
      const run = async (button) => {
        await s.cmd('FileMaker: Delete Record');
        await answerPickers(s, ['Mock Quality', 'Products']);
        await s.inputBox(String(rec), { timeout: 15000 });
        const text = await s.waitModal(15000);
        await s.modal(button);
        await s.page.waitForTimeout(1500);
        return text;
      };
      const text = await run('Cancel');
      assert((await data.record('Products', rec))?.recordId === rec, 'record deleted after Cancel');
      await run('Delete');
      const gone = await data.call('GET', `/layouts/Products/records/${rec}`);
      assert(gone.body.messages[0].code === '101', 'record still exists');
      const toasts = await s.toasts();
      return `${text.slice(0, 120)} | toasts: ${toasts.join(' | ')}`;
    }
  );
  await s.step(
    J,
    'reload the window with a Record Editor open',
    'the panel comes back working or is closed; it must not come back as a dead tab',
    async () => {
      const rid = man.databases.Quality.tables.Products.conditions.clean[16];
      wv = await openEditor(s, rid);
      s.keepRestoredEditors = true;
      await s.reloadWindow();
      s.keepRestoredEditors = false;
      const tabs = await s.editorTabs();
      if (!tabs.some((t) => /Record Editor/.test(t)))
        return `no restored tab (tabs: ${tabs.join(', ') || 'none'})`;
      // A restored tab that is not in front is not rendered (the first-run Welcome tab can be in front): bring it up.
      await s.page
        .locator('.tabs-container .tab', { hasText: /Record Editor/ })
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
      await s.page.waitForTimeout(800);
      // The restored tab is a static page that says it was closed by the reload and names the command to reopen it.
      let reopenText;
      for (let i = 0; i < 10 && !reopenText; i += 1) {
        for (const f of s.page.frames()) {
          if (!/vscode-webview:\/\/[^/]+\/fake\.html/.test(f.url())) continue;
          try {
            const t = await f.locator('body').innerText({ timeout: 1500 });
            if (/Close this tab and open it again/.test(t)) reopenText = t;
          } catch {
            /* detached */
          }
        }
        if (!reopenText) await s.page.waitForTimeout(1000);
      }
      await s.closeAllEditors();
      if (!reopenText)
        throw new Error('a "FileMaker Record Editor" tab was restored with no content (a dead panel)');
      return `restored tab shows: ${reopenText.replace(/\s+/g, ' ').slice(0, 140)}`;
    }
  );
  await s.closeAllEditors();
}
