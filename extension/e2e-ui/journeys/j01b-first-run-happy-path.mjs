// Journey 1b: the first-run happy path end to end against the repository mock:
// add a profile, test the connection, save it, connect, and run the first query.
// It is the short smoke the CI job repeats on every pull request, so every step asserts a
// message the user actually reads: the wizard status, the badge, the toast, the status bar
// and the Query Builder summary. The mock stands in for the server; no real FileMaker
// server is contacted and the credentials are the mock's own fixture account.
import { ensureProfileCommands, openQueryBuilder } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J01b first run';
const PROFILE = 'First Run Mock';
const DATABASE = 'Quality';
const LAYOUT = 'Customers';
const FOUND = 220; // the mock's Customers table
const PRODUCT = 'FileMaker Data API Engine';
const VERSION = '22.0.1';

const text = async (wv, sel) =>
  (await wv.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

export async function run(ctx) {
  const { s, mock } = ctx;

  let wv;
  await s.step(
    J,
    'the connection wizard opens for a new profile',
    'the form shows the profile, server and credential fields, and says the connection is not tested yet',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Add Connection Profile');
      wv = await s.webview('#wizardForm');
      for (const id of [
        'profileName',
        'serverUrl',
        'database',
        'username',
        'password',
        'testBtn',
        'saveBtn'
      ])
        assert(await wv.locator(`#${id}`).count(), `missing #${id}`);
      assert(
        (await s.editorTabs()).some((t) => /Add Connection Profile/.test(t)),
        `tab title: ${(await s.editorTabs()).join(', ')}`
      );
      const badge = await text(wv, '#testBadge');
      assert(/not tested/i.test(badge), `the badge does not say the connection is untested: "${badge}"`);
      return `badge: "${badge}"`;
    }
  );

  await s.step(
    J,
    'Test Connection succeeds against the mock',
    'the status names the server product info and the session that was opened and closed',
    async () => {
      for (const [id, v] of Object.entries({
        profileName: PROFILE,
        serverUrl: mock.baseUrl,
        database: DATABASE,
        username: 'tester',
        password: 'testpass1'
      }))
        await wv.locator(`#${id}`).fill(v);
      await wv.locator('#testBtn').click();
      await wv
        .locator('#status:has-text("Connection successful")')
        .first()
        .waitFor({ timeout: 30000 });
      const st = await text(wv, '#status');
      assert(/Session opened and closed cleanly/i.test(st), `status: "${st}"`);
      assert(st.includes(PRODUCT), `status: "${st}"`);
      assert(st.includes(VERSION), `status: "${st}"`);
      const badge = await text(wv, '#testBadge');
      assert(/Test passed/i.test(badge), `the badge does not say the test passed: "${badge}"`);
      return `status: "${st}" | badge: "${badge}"`;
    }
  );

  await s.step(
    J,
    'the mock answers the server-level calls Test Connection makes',
    'the mock log shows a GET for productInfo and a GET for databases, both answered with 200',
    async () => {
      const log = await mock.log();
      const seen = log.map((l) => `${l.method} ${l.path}`);
      const productInfo = log.find((l) => l.method === 'GET' && /\/productInfo$/.test(l.path));
      const databases = log.find((l) => l.method === 'GET' && /\/databases$/.test(l.path));
      assert(productInfo, `the mock never saw GET productInfo; saw: ${seen.join(', ')}`);
      assert(databases, `the mock never saw GET databases; saw: ${seen.join(', ')}`);
      assert(
        productInfo.status === 200 && databases.status === 200,
        `statuses: productInfo ${productInfo.status}, databases ${databases.status}`
      );
      return `GET ${productInfo.path} -> ${productInfo.status}; GET ${databases.path} -> ${databases.status}`;
    }
  );

  await s.step(
    J,
    'Save is offered right after a successful test',
    'the profile is saved and the wizard says so; no "save without testing" warning appears',
    async () => {
      await wv.locator('#saveBtn').click();
      await wv.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 });
      const st = await text(wv, '#status');
      assert(st.includes(`Profile "${PROFILE}" saved.`), `status: "${st}"`);
      assert(!/Test the connection first/i.test(st), `the wizard asked to test first: "${st}"`);
      assert(!(await wv.locator('#saveAnywayBtn').count()), 'a "Save anyway" button was shown');
      return st;
    }
  );

  await s.step(
    J,
    'the saved profile appears in the FileMaker sidebar',
    'the Connections view lists the profile by name',
    async () => {
      await s.openFileMakerSidebar();
      await s.page.waitForTimeout(1000);
      const rows = await s.treeRows();
      assert(
        rows.some((r) => r.includes(PROFILE)),
        `tree: ${rows.join(' | ')}`
      );
      return rows.filter((r) => r.includes(PROFILE)).join(' | ');
    }
  );

  await s.step(
    J,
    'Connect opens a session with the stored secret',
    'a toast names the connected profile and the status bar shows it',
    async () => {
      await ensureProfileCommands(s);
      await s.closeAllEditors();
      await s.cmd('FileMaker: Connect');
      await s.page.waitForTimeout(800);
      if (await s.pickerOpen()) await s.pick(PROFILE);
      const toast = await s.waitToast(/onnected to/i, { timeout: 30000 });
      assert(toast.includes(PROFILE), `toast: "${toast}"`);
      const headline = await s.statusItem(/FileMaker:/);
      assert(
        (headline ?? '').includes(PROFILE),
        `status bar: "${headline ?? '(no FileMaker item)'}"`
      );
      return `toast: "${toast}" | status bar: "${headline}"`;
    }
  );

  await s.step(
    J,
    'the first query runs against the mock and returns rows',
    'the Query Builder reports the found count and a completed status, and the mock saw the find',
    async () => {
      const wv2 = await openQueryBuilder(s, LAYOUT, PROFILE);
      const profileLabel = await wv2
        .locator('#profileSelect option:checked')
        .first()
        .innerText()
        .catch(() => '');
      assert(
        profileLabel.includes(PROFILE),
        `the Query Builder is on another profile: "${profileLabel}"`
      );
      await wv2.locator('#jsonTab').click();
      await wv2.locator('#findJson').fill('[{"CustomerID":"*"}]');
      await wv2.locator('#runButton').click();
      await wv2
        .locator('#resultSummary:not(:empty)')
        .first()
        .waitFor({ timeout: 30000 });
      await s.page.waitForTimeout(1200);
      const sum = await text(wv2, '#resultSummary');
      const st = await text(wv2, '#status');
      assert(sum.includes(String(FOUND)), `summary: "${sum}"`);
      assert(/Query completed/i.test(st), `status: "${st}"`);
      assert(!/error|fail/i.test(st), `status: "${st}"`);
      const log = await mock.log();
      const find = [...log].reverse().find((l) => l.path.endsWith('/_find'));
      assert(find, 'the mock never saw a find request');
      assert(find.status === 200, `the find was answered with ${find.status}`);
      return `summary: "${sum}" | status: "${st}" | mock saw ${find.method} ${find.path} -> ${find.status}`;
    }
  );

  await s.closeAllEditors();
}
