// Journey 13b: failure modes: account privileges, record errors, scripts and data shape (docs/FILEMAKER_FAILURE_MODES.md
// sections 3 and 4). FAIL rows confirm "gap" hypotheses.
import fs from 'node:fs';
import path from 'node:path';

import {
  answerFileDialog,
  answerPickers,
  batchExport,
  connect,
  createProfile,
  ensureProfileCommands,
  expandTreeRow,
  openQueryBuilder
} from '../lib/flows.mjs';
import { observe, summarise, toastInfo } from '../lib/observe.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J13b accounts+records';
const field = (wv, name) => wv.locator(`#fieldEditor tr:has(td:text-is("${name}")) textarea`);
const status = async (wv) => (await wv.locator('#status').innerText()).replace(/\s+/g, ' ').trim();

async function openEditor(s, profile, layout, recordId) {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Open Record Editor');
  await answerPickers(s, [profile, layout]);
  if (await s.pickerOpen()) await s.inputBox(String(recordId), { timeout: 10000 });
  const wv = await s.webview('#recordIdInput');
  await wv
    .locator('#layoutSelect')
    .selectOption(layout)
    .catch(() => {});
  if (!(await wv.locator('#fieldEditor textarea').count())) {
    await wv.locator('#recordIdInput').fill(String(recordId));
    await wv.locator('#loadButton').click();
  }
  await wv.locator('#fieldEditor textarea').first().waitFor({ timeout: 20000 });
  return wv;
}
async function saveEdit(s, wv) {
  await wv.locator('#saveButton').click();
  await s.modal('Save', { timeout: 15000 });
  await s.page.waitForTimeout(3000);
  return { st: await status(wv), toasts: await toastInfo(s) };
}

export async function run(ctx) {
  const { s, mock } = ctx;
  s.trustThrow = true; // these journeys judge by throwing a finding message
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await mock.admin('/__admin/many', { db: 'Quality', n: 200 }); // before anything lists layouts: the layout list is cached for 60 s
  await createProfile(s, {
    name: 'Sales Viewer',
    url: mock.baseUrl,
    database: 'Sales',
    username: 'viewer',
    password: 'viewpass1'
  });
  await createProfile(s, {
    name: 'Sales Limited',
    url: mock.baseUrl,
    database: 'Sales',
    username: 'limited',
    password: 'limitpass1'
  });
  await ensureProfileCommands(s);
  await s.setSetting('filemaker.requestTimeoutMs', 2500);
  await s.reloadWindow();
  await ensureProfileCommands(s);
  const fault = (f) => mock.admin('/__admin/fault', f);
  const clear = () => mock.admin('/__admin/fault', { clear: true });
  const data = mock.data('Quality');
  const man = await mock.manifest();

  // ---- accounts ----------------------------------------------------------------------------------------
  await s.step(
    J,
    '3.1 limited account sees one layout',
    'Explorer and pickers list only Contacts; nothing says why the others are missing',
    async () => {
      await connect(s, 'Sales Limited');
      await s.openFileMakerSidebar();
      await s.page.waitForTimeout(1200);
      await expandTreeRow(s, 'Sales Limited');
      await s.page.waitForTimeout(1500);
      const rows = await s.allTreeRows();
      if (!rows.includes('Contacts') || rows.includes('Invoices'))
        throw new Error(`rows: ${rows.join(' | ')}`);
      return `layouts shown: ${rows.filter((r) => /^(Contacts|Invoices)$/.test(r)).join(', ')}`;
    }
  );
  let wv;
  await s.step(
    J,
    '3.4 read-only account with a hidden field: the editor shows no Email',
    'field simply absent; any hint that hidden fields are not shown',
    async () => {
      await connect(s, 'Sales Viewer');
      wv = await openEditor(s, 'Sales Viewer', 'Contacts', 1001);
      const names = await wv.locator('#fieldEditor tbody tr td:first-child').allInnerTexts();
      if (names.includes('Email'))
        throw new Error('Email is visible although the account cannot see it');
      const note = await wv.locator('body').innerText();
      if (!/cannot see|hidden|not shown/i.test(note))
        throw new Error(
          `Email is silently missing from the form with no explanation (confirms 3.4): fields shown: ${names.join(', ')}`
        );
      return `fields: ${names.join(', ')}`;
    }
  );
  await s.step(
    J,
    '3.6 viewer edits a field and saves (server answers 500 + 200 "Record access is denied")',
    'a truthful refusal; never success; no Edit Profile button for a privilege problem',
    async () => {
      await field(wv, 'Region').fill('Moon');
      const { st, toasts } = await saveEdit(s, wv);
      const rec = await mock.data('Sales', 'tester', 'testpass1').record('Contacts', '1001');
      if (rec.fieldData.Region === 'Moon') throw new Error('the write reached the server');
      if (/saved|success|updated/i.test(st) && !/not|denied|fail|200/i.test(st))
        throw new Error(`status claims success: ${st}`);
      return `status: "${st}" | toasts: ${toasts.map((t) => `${t.text} [${t.buttons.join('/')}]`).join(' || ') || 'none'}`;
    }
  );
  await s.step(
    J,
    '3.6b viewer deletes a record (403 + code 9)',
    'a clear refusal; Edit Profile is not offered for a privilege error (S7)',
    async () => {
      await s.closeAllEditors();
      const o = await observe(s, mock, async () => {
        await s.cmd('FileMaker: Delete Record');
        await answerPickers(s, ['Sales Viewer', 'Contacts']);
        await s.inputBox('1002', { timeout: 15000 });
        await s.modal('Delete', { timeout: 15000 });
      });
      const rec = await mock.data('Sales').record('Contacts', '1002');
      if (!rec) throw new Error('the record was deleted despite the refusal');
      if (o.toasts.some((t) => t.buttons.includes('Edit Profile')))
        throw new Error(
          `Edit Profile is offered for a privilege error (confirms S7) :: ${summarise(o)}`
        );
      return summarise(o);
    }
  );
  await s.step(
    J,
    '3.7 batch update with the read-only account',
    'one clear reason, no retries per record (S1)',
    async () => {
      const csv = path.join(s.ws, 'viewer-update.csv');
      fs.writeFileSync(csv, 'recordId,Region\n1001,A\n1002,B\n1003,C\n');
      const before = (await mock.log()).filter((l) => l.method === 'PATCH').length;
      await s.closeAllEditors();
      await s.cmd('FileMaker: Batch Update from CSV/JSON');
      await answerPickers(s, ['Sales Viewer', 'Contacts']);
      await answerFileDialog(s, csv, { timeout: 15000 });
      await s.quickInputOpen();
      await s.page.waitForTimeout(500);
      await s.page.locator('.quick-input-box input').first().fill('');
      await s.pick('Execute');
      await s.modal('Execute', { timeout: 15000 });
      await s.page.waitForTimeout(12000);
      const patches = (await mock.log()).filter((l) => l.method === 'PATCH').slice(before);
      const per = patches.length / 3;
      if (per > 1)
        throw new Error(
          `${patches.length} PATCH requests for 3 records: every refusal was retried (confirms S1)`
        );
      return `${patches.length} PATCH requests for 3 records`;
    }
  );
  await s.cmd('FileMaker: Disconnect').catch(() => {});

  // ---- records -----------------------------------------------------------------------------------------------
  const pid = man.databases.Quality.tables.Products.conditions.clean[12];
  await connect(s, 'Mock Quality');
  await s.step(
    J,
    '3.5 read-only field: PATCH answers 500 + 201',
    'the editor disables the field up front, or the 201 message is clear',
    async () => {
      wv = await openEditor(s, 'Mock Quality', 'Products', pid);
      await fault({ name: 'field-readonly', field: 'Name', path: '/records' });
      const disabled = await field(wv, 'Name').evaluate((el) => el.disabled || el.readOnly);
      await field(wv, 'Name').fill('read-only attempt');
      const { st, toasts } = await saveEdit(s, wv);
      await clear();
      if (!disabled && !/201|cannot be modified|read.only/i.test(st))
        throw new Error(`late and unclear: ${st}`);
      return `field disabled up front: ${disabled}; status: "${st}"`;
    }
  );
  for (const [name, code, txt] of [
    ['record-locked', 301, /301|in use|locked/i],
    ['record-gone', 101, /101|missing|deleted/i],
    ['validation-fail', 509, /509|valid|required/i]
  ]) {
    await s.step(
      J,
      `4.8/4.9 ${name} (${code}) on Save`,
      'friendly text; 301 retried at most once; no success claim',
      async () => {
        wv = await openEditor(s, 'Mock Quality', 'Products', pid);
        await fault({ name, path: '/records' });
        const before = (await mock.log()).filter((l) => l.method === 'PATCH').length;
        await field(wv, 'Name').fill(`edit during ${name}`);
        const { st } = await saveEdit(s, wv);
        const tries = (await mock.log()).filter((l) => l.method === 'PATCH').length - before;
        await clear();
        if (/saved|success|updated/i.test(st) && !/not|fail/i.test(st))
          throw new Error(`claims success: ${st}`);
        if (!txt.test(st)) throw new Error(`the code is not recognisable in: ${st}`);
        return `status: "${st}"; PATCH attempts: ${tries}`;
      }
    );
  }
  await s.step(
    J,
    'S5 edit succeeds but a script trigger fails (scriptError 3 after save)',
    'a warning names the script error; success is not shown unqualified',
    async () => {
      wv = await openEditor(s, 'Mock Quality', 'Products', pid);
      await fault({ name: 'script-error-after-edit', path: '/records', count: 1 });
      await field(wv, 'Name').fill('edit with a failing trigger');
      const { st, toasts } = await saveEdit(s, wv);
      await clear();
      if (!/script/i.test(st + JSON.stringify(toasts)))
        throw new Error(
          `no mention of the script error: "${st}" toasts ${toasts.map((t) => t.text).join('|')} (confirms S5)`
        );
      return st;
    }
  );

  // ---- scripts -------------------------------------------------------------------------------------------------
  const runScript = async (name, param, f) => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Open Script Runner');
    await answerPickers(s, ['Mock Quality', 'Customers']);
    if (await s.pickerOpen()) await s.inputBox('', { timeout: 10000 });
    const w = await s.webview('#scriptNameInput');
    await w
      .locator('#layoutSelect')
      .selectOption('Customers')
      .catch(() => {});
    if (f) await fault(f);
    await w.locator('#scriptNameInput').fill(name);
    await w.locator('#scriptParamInput').fill(param);
    const t0 = Date.now();
    await w.locator('#runButton').click();
    await w
      .locator('#summary:not(:empty), #rawResult:not(:empty), #status:not(:empty)')
      .first()
      .waitFor({ timeout: 40000 });
    await s.page.waitForTimeout(3500);
    const out = {
      st: await status(w),
      sum: (await w.locator('#summary').innerText()).replace(/\s+/g, ' '),
      raw: (await w.locator('#rawResult').innerText()).replace(/\s+/g, ' '),
      ms: Date.now() - t0,
      toasts: await toastInfo(s)
    };
    await clear();
    return out;
  };
  await s.step(
    J,
    '3.11 script returns scriptError 3',
    'the error is visible and not shown as plain success',
    async () => {
      const o = await runScript('Echo', 'x', { name: 'script-error', path: '/script/|/_find|/records/' });
      if (!/script error|scriptError.{0,6}[1-9]|error 3|\b3\b/.test(o.sum + ' ' + o.st))
        throw new Error(
          `scriptError 3 is only inside the raw JSON; the headline says "${o.st}" / "${o.sum}" (raw has it: ${/scriptError.{0,6}3/.test(o.raw)})`
        );
      return `${o.sum} | ${o.st}`;
    }
  );
  await s.step(
    J,
    '4.12 slow script (20 s) with a 2.5 s timeout',
    'timeout wording says the script may still be running on the server',
    async () => {
      const o = await runScript('Echo', 'x', { name: 'script-slow', path: '/script/|/_find|/records/', count: 2 });
      const txt = `${o.st} ${o.sum} ${o.toasts.map((t) => t.text).join(' ')}`;
      if (!/still (be )?running|may still/i.test(txt))
        throw new Error(
          `message does not say the script may still run (confirms N9): ${txt.slice(0, 240)}`
        );
      return txt.slice(0, 240);
    }
  );
  await s.step(
    J,
    '4.12b script with a 2 MB result',
    'the panel stays responsive; the result is truncated or shown safely',
    async () => {
      const o = await runScript('Echo', 'x', { name: 'script-huge-result', path: '/script/' });
      assert(o.ms < 20000, `the panel took ${o.ms} ms to show a 2 MB result`);
      assert(o.raw.length > 0 || String(o.st).length > 0, 'nothing was shown for the 2 MB result');
      assert(
        o.raw.length < 4 * 1024 * 1024,
        `the whole 2 MB result is rendered (${o.raw.length} chars)`
      );
      return `rendered in ${o.ms} ms; raw ${o.raw.length} chars; ${o.st}`;
    }
  );

  // ---- layouts, schema, data shape ---------------------------------------------------------------------------------------
  await s.step(
    J,
    '4.2/N5 layouts with spaces, slashes, %, ?, Unicode and a duplicate name',
    'each name is kept exactly (including a leading space) and opens; an identical name is listed once',
    async () => {
      const w = await openQueryBuilder(s, 'Customers');
      const opts = await w.locator('#layoutSelect option').allInnerTexts();
      const wants = ['A/B', ' Sales', 'Percent%20Layout', 'Ünïcode Layöut', 'Question?Mark'];
      const missing = wants.filter((n) => !opts.some((o) => o === n));
      // An identical name (here "Customers" at the top level and in a folder) is one layout to the Data API,
      // which addresses a layout by its exact name, so it is listed once.
      const customers = opts.filter((o) => o === 'Customers').length;
      const problems = [];
      if (missing.length) problems.push(`names altered or dropped: ${JSON.stringify(missing)}`);
      if (customers !== 1)
        problems.push(`the identical name "Customers" is listed ${customers} times (expected once)`);
      // open each that is listed
      const results = [];
      for (const n of wants.filter((x) => opts.includes(x) || opts.includes(x.trim()))) {
        const val = opts.includes(n) ? n : n.trim();
        await w
          .locator('#layoutSelect')
          .selectOption({ label: val })
          .catch(() => {});
        await w.locator('#jsonTab').click();
        await w.locator('#findJson').fill('[{}]');
        await w.locator('#runButton').click();
        await s.page.waitForTimeout(1500);
        results.push(
          `${JSON.stringify(val)} -> ${(await w.locator('#resultSummary').innerText()).replace(/\s+/g, ' ').slice(0, 50)} / ${(await status(w)).slice(0, 60)}`
        );
      }
      await s.closeAllEditors();
      if (problems.length)
        throw new Error(`${problems.join('; ')} (confirms N5) :: ${results.join(' | ')}`);
      return results.join(' | ');
    }
  );
  await s.step(
    J,
    '4.1 layout changed while open: a field is removed on the server',
    'the next find with the old field gives a clear 102 message; the schema cache is dropped so the next try works',
    async () => {
      const w = await openQueryBuilder(s, 'Products');
      await mock.admin('/__admin/schema', {
        db: 'Quality',
        table: 'Products',
        removeField: 'Description'
      });
      await w.locator('#jsonTab').click();
      await w.locator('#findJson').fill('[{"Description":"*"}]');
      await w.locator('#runButton').click();
      await s.page.waitForTimeout(2500);
      const first = await status(w);
      await w.locator('#findJson').fill('[{"Name":"*"}]');
      await w.locator('#runButton').click();
      await s.page.waitForTimeout(2000);
      const names = await w.locator('.results-table thead th').allInnerTexts();
      await mock.admin('/__admin/schema', {
        db: 'Quality',
        table: 'Products',
        addField: { name: 'Description', result: 'text' }
      });
      await s.closeAllEditors();
      if (!/102|missing|field/i.test(first)) throw new Error(`first message unclear: ${first}`);
      return `first: "${first}"; columns after: ${names.slice(0, 7).join(',')}`;
    }
  );
  await s.step(
    J,
    '4.4/N4 export of exactly 200 records with maxRecords 200, past-the-end page answered 500/401',
    'export finishes with 200 rows and no error',
    async () => {
      await s.setSetting('filemaker.batch.maxRecords', 200);
      await s.dismissToasts();
      await s.cmd('FileMaker: Refresh Schema Cache');
      const out = path.join(s.ws, 'big.csv');
      fs.rmSync(out, { force: true });
      await fault({ name: 'find-no-match-500', path: '/_find' });
      try {
        await batchExport(s, 'Big', '[{"Label":"*"}]', out);
      } finally {
        await clear();
        await s.setSetting('filemaker.batch.maxRecords', undefined);
      }
      const toasts = await toastInfo(s);
      const lines = fs.existsSync(out)
        ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length - 1
        : -1;
      if (lines !== 200)
        throw new Error(
          `exported ${lines} rows instead of 200; toasts: ${toasts.map((t) => t.text).join(' | ')}`
        );
      return `200 rows exported; toasts: ${toasts.map((t) => t.text).join(' | ') || 'none'}`;
    }
  );
  await s.step(
    J,
    '4.5 portal with 170 related rows: Record Viewer',
    'the viewer says the portal is limited to 50 rows',
    async () => {
      const id = man.databases.Quality.tables.Customers.conditions['portal-many'][0];
      await s.closeAllEditors();
      await s.cmd('FileMaker: Open Record Viewer');
      await answerPickers(s, ['Mock Quality', 'Customers']);
      if (await s.pickerOpen()) await s.inputBox(String(id), { timeout: 10000 });
      const v = await s.webview('#relatedDataContainer', { visible: false });
      await v.locator('#loadButton').click();
      await s.page.waitForTimeout(3500);
      const text = (await v.locator('#relatedDataContainer').innerText()).replace(/\s+/g, ' ');
      const rows = await v.locator('#relatedDataContainer tbody tr').count();
      await s.closeAllEditors();
      if (
        !/50|limit|more/i.test(text.slice(0, 300)) ||
        (rows >= 50 && !/limited|first 50|more/i.test(text))
      )
        throw new Error(
          `${rows} related rows shown with no notice that 120 more exist (confirms 4.5)`
        );
      return `${rows} rows; ${text.slice(0, 120)}`;
    }
  );
  await s.setSetting('filemaker.requestTimeoutMs', undefined);
}
