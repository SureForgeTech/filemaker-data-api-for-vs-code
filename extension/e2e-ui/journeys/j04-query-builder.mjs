// Journey 4: Query Builder: find, page, sort, view a record, copy as table, export CSV/JSON, no-match handling.
import fs from 'node:fs';
import path from 'node:path';

import {
  answerFileDialog,
  connect,
  createProfile,
  ensureProfileCommands,
  openQueryBuilder,
  readClipboard
} from '../lib/flows.mjs';
import { parseCsv } from '../lib/csv.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J04 query builder';
const summary = async (wv) =>
  (await wv.locator('#resultSummary').innerText()).replace(/\s+/g, ' ').trim();
const statusText = async (wv) =>
  (await wv.locator('#status').innerText()).replace(/\s+/g, ' ').trim();
async function runJson(wv, find, { sort, limit, offset } = {}) {
  await wv.locator('#jsonTab').click();
  await wv.locator('#findJson').fill(find);
  await wv.locator('#sortJson').fill(sort ?? '');
  await wv.locator('#limitInput').fill(limit ? String(limit) : '');
  await wv.locator('#offsetInput').fill(offset ? String(offset) : '');
  await wv.locator('#runButton').click();
  await wv
    .locator('#resultSummary:not(:empty), #status:not(:empty)')
    .first()
    .waitFor({ timeout: 20000 });
  await wv.page().waitForTimeout(1200);
}

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  const headline = await s.statusItem(/FileMaker:/);
  if (!/Mock Quality/.test(headline ?? '')) await connect(s, 'Mock Quality');

  let wv;
  await s.step(
    J,
    'open the Query Builder',
    'panel opens with Profile, Layout, Find JSON and Run',
    async () => {
      wv = await openQueryBuilder(s, 'Customers');
      for (const id of ['profileSelect', 'layoutSelect', 'runButton', 'limitInput', 'offsetInput'])
        assert(await wv.locator(`#${id}`).count(), `missing #${id}`);
      const layout = await wv.locator('#layoutSelect').inputValue();
      return `layout selected: ${layout}`;
    }
  );
  await s.step(
    J,
    'list records without empty find criteria',
    'first page of 100 rows, found count 220, Next enabled',
    async () => {
      await wv
        .locator('#layoutSelect')
        .selectOption('Customers')
        .catch(() => {});
      // Empty find criteria are rejected intentionally; use an explicit match-all criterion.
      await runJson(wv, '[{"CustomerID":"*"}]');
      const sum = await summary(wv);
      assert(/220/.test(sum), `summary: ${sum}`);
      const rows = await wv.locator('.results-table tbody tr:not(.spacer)').count();
      assert(rows > 5, `rendered rows: ${rows}`);
      assert(await wv.locator('#nextButton').isEnabled(), 'Next page disabled');
      return `${sum} (${rows} DOM rows, table is virtualised)`;
    }
  );
  await s.step(
    J,
    'page forward and back',
    'Next shows records 101-200 (server offset 101), Previous returns',
    async () => {
      await wv.locator('#nextButton').click();
      await s.page.waitForTimeout(1500);
      const log = await mock.log();
      const last = [...log].reverse().find((l) => /records|_find/.test(l.path));
      const sum = await summary(wv);
      assert(/101.200/.test(sum), `after Next the summary says: ${sum}`);
      assert(
        (last?.body?.offset ?? Number(last?.query?.match(/offset=(\d+)/)?.[1])) === 101,
        `server offset is not 101: ${JSON.stringify(last?.body ?? last?.query)}`
      );
      await wv.locator('#prevButton').click();
      await s.page.waitForTimeout(1200);
      const back = await summary(wv);
      assert(/1.100/.test(back), `after Previous the summary says: ${back}`);
      return `after Next: ${sum}; last request ${last?.method} ${last?.path} ${last?.query ?? ''} ${JSON.stringify(last?.body ?? {}).slice(0, 120)}`;
    }
  );
  await s.step(
    J,
    'find by field value via the Form tab',
    'form conditions produce the right find (Status equals Open)',
    async () => {
      await wv.locator('#formTab').click();
      await s.page.waitForTimeout(500);
      const hasRequest = await wv.locator('#requestList .request-card').count();
      if (!hasRequest) await wv.locator('#addRequestButton').click();
      await wv.locator('.criterion-field').first().fill('Status');
      const op = wv.locator('.criterion-operator').first();
      const ops = await op.locator('option').allInnerTexts();
      await op.selectOption({
        label: ops.find((o) => /equals|is exactly|^is$/i.test(o)) ?? ops[1]
      });
      await wv.locator('.criterion-value').first().fill('Open');
      await wv.locator('#runButton').click();
      await wv.locator('#resultSummary:not(:empty)').first().waitFor({ timeout: 15000 });
      await s.page.waitForTimeout(1200);
      const last = [...(await mock.log())].reverse().find((l) => l.path.endsWith('/_find'));
      return `${await summary(wv)} | operators: ${ops.join(', ')} | request ${JSON.stringify(last?.body)}`;
    }
  );
  await s.step(
    J,
    'sort through the JSON tab (descending Balance)',
    'rows come back in descending order',
    async () => {
      await runJson(wv, '[{"CustomerID":"*"}]', {
        sort: '[{"fieldName":"Balance","sortOrder":"descend"}]',
        limit: 25
      });
      const header = await wv.locator('.results-table thead th').allInnerTexts();
      const idx = header.findIndex((h) => /Balance/.test(h));
      assert(idx > 0, `Balance column not shown; columns: ${header.slice(0, 8).join(',')}`);
      const cells = await wv
        .locator(`.results-table tbody tr:not(.spacer) td:nth-child(${idx + 1})`)
        .allInnerTexts();
      const nums = cells.map(Number).filter((n) => Number.isFinite(n));
      assert(
        nums.length > 5 && nums.every((n, i) => i === 0 || nums[i - 1] >= n),
        `Balance column: ${cells.slice(0, 8).join(', ')}`
      );
    }
  );
  await s.step(
    J,
    'click a column header to sort the loaded page',
    'the table re-orders',
    async () => {
      const btn = wv
        .locator('.results-table thead th button.sort-header', { hasText: 'LastName' })
        .first();
      if (!(await btn.count()))
        return { result: 'NOTE', detail: 'LastName column not displayed on this layout page' };
      await btn.click();
      await s.page.waitForTimeout(500);
      const cells = await wv
        .locator('.results-table tbody tr:not(.spacer) td:nth-child(5)')
        .allInnerTexts();
      return cells.slice(0, 5).join(' | ');
    }
  );
  await s.step(
    J,
    'no matches: HTTP 404 + FileMaker code 401',
    'a friendly empty result, not an error',
    async () => {
      await runJson(wv, '[{"LastName":"zzzz-nothing"}]');
      const sum = await summary(wv);
      const st = await statusText(wv);
      const log = await mock.log();
      const last = [...log].reverse().find((l) => l.path.endsWith('/_find'));
      assert(
        last?.status === 404 && last?.code === '401',
        `server answered ${last?.status}/${last?.code}`
      );
      assert(!/error|fail/i.test(st), `status shows an error: ${st}`);
      return `summary: "${sum}" status: "${st}"`;
    }
  );
  await s.step(
    J,
    'invalid JSON in the Find box',
    'a clear validation message, no request sent',
    async () => {
      const before = (await mock.log()).length;
      await runJson(wv, '[{"a":');
      const st = await statusText(wv);
      assert(/JSON|invalid|parse/i.test(st), `status: ${st}`);
      assert((await mock.log()).length === before, 'a request was sent');
      return st;
    }
  );
  await s.step(
    J,
    'open a record from the results (double-click)',
    'Record Viewer opens with the field data',
    async () => {
      await runJson(wv, '[{"CustomerID":"C-0001"}]');
      const row = wv.locator('.results-table tbody tr[data-record-id]').first();
      await row.locator('td').nth(2).dblclick({ force: true });
      await s.page.waitForTimeout(2500);
      const tabs = await s.editorTabs();
      assert(
        tabs.some((t) => /Record/i.test(t)),
        `tabs: ${tabs.join(', ')}`
      );
      const viewer = await s.webview('#fieldDataContainer', { visible: false });
      let loadedBy = 'automatically';
      const hasFields = async () =>
        (await viewer.locator('.loading-skeleton:not(.hidden)').count()) === 0 &&
        /CustomerID/.test(await viewer.locator('body').innerText());
      for (let i = 0; i < 20 && !(await hasFields()); i += 1) await s.page.waitForTimeout(500);
      if (!(await hasFields())) {
        loadedBy =
          'only after clicking Load Record (the panel opened for a record id but stayed on the loading skeleton for 10 s)';
        await viewer.locator('#loadButton').click();
        for (let i = 0; i < 20 && !(await hasFields()); i += 1) await s.page.waitForTimeout(500);
      }
      const text = await viewer.locator('body').innerText();
      assert(
        /CustomerID/.test(text),
        `viewer never showed the record: ${text.replace(/\s+/g, ' ').slice(0, 160)}`
      );
      if (!/automatically/.test(loadedBy))
        throw new Error(`Record Viewer opened from a results row ${loadedBy}`);
      return `tabs: ${tabs.join(', ')}`;
    }
  );
  wv = await s.webview('#runButton');
  await s.step(
    J,
    'copy results as table',
    'tab-separated text on the clipboard with a header row',
    async () => {
      await s.page
        .locator('.tab', { hasText: 'Query Builder' })
        .first()
        .click()
        .catch(() => {});
      wv = await s.webview('#runButton');
      await runJson(wv, '[{"CustomerID":"C-000*"}]', { limit: 5 });
      await wv.locator('#exportMenu summary').click();
      await wv.locator('#copyTableButton').click();
      await s.page.waitForTimeout(800);
      const clip = await readClipboard(s);
      assert(
        /CustomerID/.test(clip.split('\n')[0]) && clip.includes('\t'),
        `clipboard: ${clip.slice(0, 100)}`
      );
      return `${clip.split('\n').length} lines`;
    }
  );
  await s.step(
    J,
    'Save results as CSV: formulas are neutralised',
    'cells starting with = + - @ tab CR are prefixed so spreadsheets do not run them',
    async () => {
      await runJson(wv, '[{"LastName":"Formula*"}]', { limit: 50 });
      const out = path.join(s.ws, 'export-formulas.csv');
      fs.rmSync(out, { force: true });
      await wv.locator('#exportMenu summary').click();
      await wv.locator('#exportCsvButton').click();
      // CSV asks for an encoding format before it opens the save-path input.
      await s.pick('Standard CSV');
      await answerFileDialog(s, out);
      await s.waitToast(/xported|aved/i, { timeout: 15000 }).catch(() => {});
      assert(fs.existsSync(out), 'CSV file was not written');
      const csv = fs.readFileSync(out, 'utf8');
      const table = parseCsv(csv);
      const dangerous = table
        .slice(1)
        .flatMap((r) => r)
        .filter((c) => /^[=+\-@\t\r]/.test(c));
      const lfStart = table
        .slice(1)
        .flatMap((r) => r)
        .filter((c) => /^[\n ]+[=+\-@]/.test(c));
      const apostropheDoubled = table
        .slice(1)
        .flatMap((r) => r)
        .filter((c) => /^''[=+\-@]/.test(c));
      ctx.csvNeutralised = csv;
      fs.writeFileSync(path.join(ctx.artifacts, 'export-formulas.csv'), csv);
      return `${csv.split('\n').length} lines; un-neutralised formula cells: ${dangerous.length}${dangerous.length ? ` e.g. ${JSON.stringify(dangerous.slice(0, 3))}` : ''}; cells that already began with an apostrophe and got a second one: ${apostropheDoubled.length}; cells starting with a space or line feed before a formula character (left as is): ${lfStart.length}`;
    }
  );
  await s.step(
    J,
    'Save results as JSON and open results in editor',
    'JSON file exists; editor shows the records',
    async () => {
      const out = path.join(s.ws, 'export.json');
      fs.rmSync(out, { force: true });
      await wv.locator('#exportMenu summary').click();
      await wv.locator('#exportJsonButton').click();
      await answerFileDialog(s, out);
      await s.page.waitForTimeout(1200);
      assert(fs.existsSync(out), 'JSON file not written');
      JSON.parse(fs.readFileSync(out, 'utf8'));
      await wv.locator('#exportMenu summary').click();
      await wv.locator('#exportEditorButton').click();
      await s.page.waitForTimeout(1500);
      return (await s.editorTabs()).join(', ');
    }
  );
  await s.closeAllEditors();
}
