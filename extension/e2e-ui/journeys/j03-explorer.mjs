// Journey 3: Explorer: connect, browse databases/layouts, layout inspector, refresh, session expiry mid-use.
import {
  connect,
  createProfile,
  ensureProfileCommands,
  expandTreeRow,
  refreshExplorer
} from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J03 explorer';
export async function run(ctx) {
  const { s, mock } = ctx;
  if (!(await s.waitCmdListed('FileMaker: Add Connection Profile', 3000)) < 0) {
    /* always listed */
  }
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);

  await s.step(
    J,
    'FileMaker: Connect',
    'a picker names profile, database and server; "Connected to" notice; status bar shows the profile',
    async () => {
      await s.dismissToasts(); // a previous journey's Connected toast cannot satisfy this step
      await s.cmd('FileMaker: Connect');
      await s.page.waitForTimeout(700);
      const prompted = await s.pickerOpen();
      let items = [];
      if (prompted) {
        items = await s.pickerItems();
        await s.pick('Mock Quality');
      }
      const t = await s.waitToast(/Connected to "Mock Quality"/i, { timeout: 25000 });
      // Finish Connect's optional layout prompt and dispose its temporary status item.
      if (await s.pickerOpen()) await s.escape();
      await s.page.waitForTimeout(1500);
      const sb = await s.statusItem(/FileMaker:/);
      assert(/Mock Quality/.test(sb ?? '') && !/Connecting/i.test(sb ?? ''), `status bar: ${sb}`);
      return `${t} | picker (${prompted ? 'shown' : 'not shown'}): ${items.join(' / ')} | status: ${sb}`;
    }
  );
  await s.step(
    J,
    'a layout picker opens after connect (for the Layout Inspector)',
    'user can choose a layout or dismiss',
    async () => {
      const open = await s.pickerOpen();
      if (open) {
        const items = await s.pickerItems();
        await s.escape();
        return `picker with ${items.length} items shown after connect`;
      }
      return 'no picker';
    }
  );
  await s.openFileMakerSidebar();
  await s.step(
    J,
    'expand the profile: layouts listed (folders flattened)',
    'Customers, Orders, Products, Documents and layouts inside folders are listed',
    async () => {
      await expandTreeRow(s, 'Mock Quality');
      await s.page.waitForTimeout(1500);
      const rows = await s.allTreeRows();
      for (const n of [
        'Customers',
        'Orders',
        'LineItems',
        'Products',
        'Documents',
        'Customers 2019',
        'CustomersList'
      ])
        assert(rows.includes(n), `missing layout ${n}`);
      return `${rows.length} rows`;
    }
  );
  await s.step(
    J,
    'hostile layout names are shown literally and are not dropped',
    'all 16 hostile layout names appear in the tree',
    async () => {
      const rows = await s.allTreeRows();
      const missing = [];
      for (const n of ctx.mock.hostileLayoutNames ??
        (await (await fetch(`${mock.adminUrl}/__admin/manifest`)).json()).hostileLayoutNames) {
        if (
          !rows.some(
            (r) =>
              r === n || r === n.trim() || r.replace(/\s+/g, ' ') === n.replace(/\s+/g, ' ').trim()
          )
        )
          missing.push(JSON.stringify(n));
      }
      assert(
        missing.length === 0,
        `not shown (tree may be virtualised, or names were altered): ${missing.join(', ')}`
      );
    }
  );
  await s.step(
    J,
    'expand a layout: Fields, Value Lists, Schema Snapshots',
    'the three groups appear; Fields lists field names with types',
    async () => {
      await expandTreeRow(s, 'Customers');
      await s.page.waitForTimeout(1200);
      let rows = await s.treeRows();
      assert(
        rows.includes('Fields') && rows.includes('Value Lists'),
        `rows: ${rows.slice(0, 25).join(' | ')}`
      );
      await expandTreeRow(s, 'Fields');
      await s.page.waitForTimeout(1200);
      rows = await s.treeRows();
      const fields = rows.filter((r) =>
        /(text|number|date|timeStamp|time|container)\s*[\u00b7\u2022]\s*x\d/i.test(r)
      );
      assert(fields.length >= 5, `field rows: ${rows.slice(0, 12).join(' | ')}`);
      return `${fields.length} typed field rows; sample: ${fields.slice(0, 4).join(' | ')}`;
    }
  );
  await s.step(
    J,
    'Layout Inspector: select a layout',
    'inspector lists fields, portals and value lists for the layout',
    async () => {
      await s.cmd('FileMaker: Select Layout for Inspector');
      await s.page.waitForTimeout(500);
      await s.pick('Customers');
      await s.page.waitForTimeout(2500);
      const body = (await s.page.locator('.pane-body').allInnerTexts()).join(' ');
      assert(/Orders|Phones|Status/.test(body), `inspector text: ${body.slice(0, 200)}`);
    }
  );
  const layoutGets = async () =>
    (await mock.log()).filter((l) => l.method === 'GET' && l.path === '/layouts').length;
  await s.step(
    J,
    'Refresh Connections',
    'the tree reloads; if the layout list is served from the 60 s cache that is visible to the user',
    async () => {
      const before = await layoutGets();
      await refreshExplorer(s);
      await s.page.waitForTimeout(1500);
      const after = await layoutGets();
      return after > before
        ? `refresh re-read the layout list (${before} -> ${after})`
        : `refresh did NOT ask the server (still ${after} GET /layouts): the layout list is cached for 60 s, so a layout added on the server does not appear until the cache expires or Refresh Schema Cache is run`;
    }
  );
  await s.step(
    J,
    'Refresh Schema Cache then Refresh Connections',
    'a fresh GET /layouts reaches the server',
    async () => {
      const before = await layoutGets();
      await s.cmd('FileMaker: Refresh Schema Cache');
      await s.page.waitForTimeout(1200);
      await refreshExplorer(s);
      await s.page.waitForTimeout(1500);
      const after = await layoutGets();
      assert(after > before, `GET /layouts ${before} -> ${after}`);
    }
  );
  await s.step(
    J,
    'session expires mid-use: next action recovers',
    'one silent re-login, no error shown to the user',
    async () => {
      const countLogins = async () =>
        (await mock.log()).filter((l) => l.method === 'POST' && l.path === '/sessions').length;
      const before = await countLogins();
      await mock.admin('/__admin/expire', {});
      await s.cmd('FileMaker: Refresh Schema Cache');
      await s.page.waitForTimeout(800);
      await refreshExplorer(s);
      await s.page.waitForTimeout(3500);
      const toasts = await s.toasts();
      const rows = await s.treeRows();
      const log = await mock.log();
      const logins = (await countLogins()) - before;
      const e952 = log.filter((l) => l.code === '952').length;
      assert(rows.includes('Customers'), `tree after expiry: ${rows.slice(0, 8).join(' | ')}`);
      assert(
        e952 >= 1 && logins === 1,
        `expected one 952 and one re-login; saw ${e952} x 952 and ${logins} logins`
      );
      return `logins after expiry: ${logins}, 952 responses seen: ${e952}, toasts: ${toasts.join(' || ') || 'none'}`;
    }
  );
  await s.step(J, 'Disconnect', 'status bar returns to Not connected', async () => {
    await s.cmd('FileMaker: Disconnect');
    await s.page.waitForTimeout(1500);
    const sb = await s.statusItem(/FileMaker:/);
    assert(/Not connected/i.test(sb ?? ''), `status bar: ${sb}`);
  });
}
