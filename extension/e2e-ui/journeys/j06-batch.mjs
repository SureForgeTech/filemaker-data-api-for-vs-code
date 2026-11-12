// Journey 6: Batch: export CSV/JSONL (incl. the nasty data), edit and re-import as an update (dry run first), results.
import fs from 'node:fs';
import path from 'node:path';

import {
  answerFileDialog,
  answerPickers,
  batchExport,
  connect,
  createProfile,
  ensureProfileCommands
} from '../lib/flows.mjs';
import { parseCsv } from '../lib/csv.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J06 batch';

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

  const csvOut = path.join(s.ws, 'customers.csv');
  await s.step(
    J,
    'Batch Export (Find) all Customers to CSV',
    'job starts; file has a header and 220 data rows; hostile values survive quoting',
    async () => {
      await batchExport(s, 'Customers', '[{"CustomerID":"*"}]', csvOut);
      assert(fs.existsSync(csvOut), 'no CSV written');
      const rows = parseCsv(fs.readFileSync(csvOut, 'utf8'));
      const header = rows[0];
      assert(
        header.includes('CustomerID') && header.includes('Notes'),
        `header: ${header.slice(0, 8)}`
      );
      const body = rows.slice(1).filter((r) => r.length > 1);
      ctx.csvRows = { header, body };
      return `${header.length} columns, ${body.length} data rows (expected 220)`;
    }
  );
  await s.step(
    J,
    'CSV: formula starters are neutralised, multi-line and Unicode intact',
    'cells beginning = + - @ tab CR are prefixed with an apostrophe; other text unchanged',
    async () => {
      const { header, body } = ctx.csvRows;
      const n = header.indexOf('Notes');
      const ids = man.databases.Quality.tables.Customers.conditions['csv-formula'];
      const byId = new Map(body.map((r) => [r[header.indexOf('CustomerID')], r]));
      const raw = body.map((r) => r[n]);
      const bad = raw.filter((c) => /^[=+\-@\t\r]/.test(c));
      const multi = raw.filter((c) => c.includes('\n')).length;
      const cjk = body.some((r) => r.join('|').includes('山田太郎'));
      assert(cjk, 'CJK text missing');
      return `un-neutralised formula cells in Notes: ${bad.length}${bad.length ? ' e.g. ' + JSON.stringify(bad.slice(0, 3)) : ''}; multi-line cells: ${multi}; csv-formula records: ${ids.length}`;
    }
  );
  await s.step(
    J,
    'Batch Export to JSONL (Customers) and the nasty Hostile layout to CSV',
    'JSONL has one valid JSON object per line; hostile field names appear as columns',
    async () => {
      const jl = path.join(s.ws, 'customers.jsonl');
      await batchExport(s, 'Customers', '[{"CustomerID":"*"}]', jl);
      const lines = fs.readFileSync(jl, 'utf8').split('\n').filter(Boolean);
      lines.forEach((l) => JSON.parse(l));
      const hostile = path.join(s.ws, 'hostile.csv');
      await batchExport(s, 'Hostile', '[{"Name":"*"}]', hostile);
      const header = parseCsv(fs.readFileSync(hostile, 'utf8'))[0];
      const missing = man.hostileFieldNames.filter((n) => !header.includes(n));
      return `JSONL lines: ${lines.length}; hostile columns present ${header.length}, names missing from header: ${JSON.stringify(missing)}`;
    }
  );

  // ---- update from a CSV -------------------------------------------------------------------
  const pids = man.databases.Quality.tables.Products.conditions.clean.slice(1, 4);
  const upd = path.join(s.ws, 'products-update.csv');
  fs.writeFileSync(
    upd,
    `recordId,Name,Price\n${pids[0]},Batch renamed A,11.5\n${pids[1]},Batch renamed B,12.5\n999999,Missing record,1\n${pids[2]},Bad category,3\n`
  );
  const batchUpdate = async (file, mode, layout = 'Products') => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Batch Update from CSV/JSON');
    await answerPickers(s, ['Mock Quality', layout]);
    await answerFileDialog(s, file, { timeout: 15000 });
    await s.quickInputOpen();
    await s.page.waitForTimeout(500);
    await s.page.locator('.quick-input-box input').first().fill(''); // the path typed into the file dialog is still in the filter box
    await s.page.waitForTimeout(300);
    await s.pick(mode);
    return s;
  };
  await s.step(
    J,
    'Batch Update: dry run first',
    'a dry-run preview opens; the server receives no PATCH',
    async () => {
      const before = (await mock.log()).filter((l) => l.method === 'PATCH').length;
      await batchUpdate(upd, 'Dry-run');
      await s.waitToast(/Started job/i, { timeout: 15000 });
      await s.page.waitForTimeout(3000);
      const after = (await mock.log()).filter((l) => l.method === 'PATCH').length;
      assert(after === before, `PATCH requests during dry run: ${after - before}`);
      const tabs = await s.editorTabs();
      return `tabs: ${tabs.join(', ')}`;
    }
  );
  await s.step(
    J,
    'Batch Update: execute (decline, then accept)',
    'Execute modal lists the count; decline writes nothing; accept writes rows and reports failures',
    async () => {
      const patches = async () => (await mock.log()).filter((l) => l.method === 'PATCH').length;
      const p0 = await patches();
      await batchUpdate(upd, 'Execute');
      const text = await s.waitModal(15000);
      assert(/4 records/.test(text), text);
      await s.modal('Cancel');
      await s.page.waitForTimeout(1500);
      assert((await patches()) === p0, 'writes after Cancel');
      await batchUpdate(upd, 'Execute');
      await s.waitModal(15000);
      await s.modal('Execute');
      await s.waitModal(15000);
      assert(/no modId column/.test(await s.modalText()), await s.modalText());
      await s.modal('Continue');
      await s.waitToast(/Started job/i, { timeout: 15000 });
      await s.page.waitForTimeout(5000);
      const a = await data.record('Products', pids[0]);
      const b = await data.record('Products', pids[1]);
      assert(
        a.fieldData.Name === 'Batch renamed A' && b.fieldData.Name === 'Batch renamed B',
        `values: ${a.fieldData.Name} / ${b.fieldData.Name}`
      );
      const toasts = await s.toasts();
      return `PATCHes: ${(await patches()) - p0}; toasts: ${toasts.join(' || ')}`;
    }
  );
  await s.step(
    J,
    'Show Jobs: results of the update',
    'the job list shows the finished update with success/failure counts',
    async () => {
      await s.page.locator('.statusbar-item', { hasText: 'FM Jobs' }).first().click();
      await s.page.waitForTimeout(1500);
      const items = (await s.pickerOpen()) ? await s.pickerItems() : [];
      const tabs = await s.editorTabs();
      if (items.length) await s.escape();
      return `jobs picker: ${items.slice(0, 4).join(' | ')} tabs: ${tabs.join(', ')}`;
    }
  );
  await s.step(
    J,
    'round trip: re-import the exported Customers CSV unchanged (execute)',
    'unchanged data should not change; calculation and global columns should not break the run; neutralised cells must not be written back as text',
    async () => {
      const id = man.databases.Quality.tables.Customers.conditions['csv-formula'][0];
      const before = await data.record('Customers', id);
      const rows = parseCsv(fs.readFileSync(csvOut, 'utf8'));
      const header = rows[0];
      const idCol = header.indexOf('recordId');
      const small = rows.filter(
        (r, i) => i === 0 || r[header.indexOf('CustomerID')] === before.fieldData.CustomerID
      );
      const file = path.join(s.ws, 'roundtrip.csv');
      fs.writeFileSync(
        file,
        small.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
      );
      await batchUpdate(file, 'Execute', 'Customers');
      await s.waitModal(15000);
      await s.modal('Execute');
      await s.waitModal(15000);
      assert(/rows have modId/.test(await s.modalText()), await s.modalText());
      await s.modal('Check for newer changes (recommended)');
      await s.waitToast(/Started job/i, { timeout: 15000 });
      await s.page.waitForTimeout(5000);
      const after = await data.record('Customers', id);
      const changed = Object.keys(before.fieldData).filter(
        (k) => String(before.fieldData[k]) !== String(after.fieldData[k])
      );
      ctx.roundTrip = {
        idCol,
        header: header.slice(0, 5),
        changed,
        before: before.fieldData.Notes,
        after: after.fieldData.Notes
      };
      assert(
        changed.length === 0 && before.modId === after.modId,
        `fields changed by an unchanged re-import: ${JSON.stringify(changed)}; Notes before=${JSON.stringify(before.fieldData.Notes)} after=${JSON.stringify(after.fieldData.Notes)}; modId ${before.modId}->${after.modId}`
      );
    }
  );
  await s.closeAllEditors();
}
