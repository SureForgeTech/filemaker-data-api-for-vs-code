// Journey 4b: Copy request as code, in the real VS Code, against the mock Data API. The request is copied from the
// Query Builder, read back from the clipboard and then actually sent: the copied curl is run with the real `curl`
// and the copied .http request is replayed with fetch, and the answers are compared with what the extension's own
// find returned. Secrets: the clipboard text must never hold the account's password or the session token.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import {
  answerPickers,
  connect,
  createProfile,
  ensureProfileCommands,
  openQueryBuilder,
  readClipboard,
  writeClipboard
} from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J04b copy request';
const PASSWORD = 'testpass1';

async function mockToken(mock) {
  const response = await fetch(`${mock.baseUrl}/fmi/data/vLatest/databases/Quality/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`tester:${PASSWORD}`).toString('base64')}`
    },
    body: '{}'
  });
  return (await response.json()).response.token;
}

/** The request of a copied `.http` file, with `{{host}}` and `{{token}}` filled in. */
function parseHttp(text, variables) {
  const lines = text.split('\n');
  const fileVariables = {};
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('###')) {
    const match = /^@(\w+) = (.*)$/.exec(lines[i]);
    if (match) fileVariables[match[1]] = match[2];
    i += 1;
  }
  const requests = lines.filter((line) => line.startsWith('###')).length;
  i += 1;
  const [method, rawUrl] = lines[i].split(' ');
  i += 1;
  const headers = {};
  while (i < lines.length && lines[i] !== '') {
    const colon = lines[i].indexOf(':');
    headers[lines[i].slice(0, colon)] = lines[i].slice(colon + 1).trim();
    i += 1;
  }
  const merged = { ...fileVariables, ...variables };
  const fill = (value) => value.replace(/\{\{(\w+)\}\}/g, (_m, name) => merged[name] ?? `{{${name}}}`);
  const body = lines.slice(i + 1).join('\n').trim();
  return {
    requests,
    method,
    url: fill(rawUrl),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, fill(v)])),
    body: body ? fill(body) : undefined
  };
}

const found = (json) => json.response?.dataInfo?.foundCount;

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? '')) await connect(s, 'Mock Quality');

  const find = '[{"CustomerID":"C-0001"}]';
  const expected = await mock.data().find('Customers', JSON.parse(find));
  let wv;

  const copyAs = async (label, { auth = false } = {}) => {
    const box = wv.locator('#includeAuthCheckbox');
    await wv.locator('#copyRequestMenu summary').click();
    if ((await box.isChecked()) !== auth) await box.setChecked(auth);
    await wv.getByRole('button', { name: label, exact: true }).click();
    await s.page.waitForTimeout(700);
    return readClipboard(s);
  };

  await s.step(
    J,
    'the Query Builder offers every format under Copy request',
    'curl, fetch(), .http, Postman, TypeScript and Save as .http file',
    async () => {
      wv = await openQueryBuilder(s, 'Customers');
      await wv.locator('#jsonTab').click();
      await wv.locator('#findJson').fill(find);
      await wv.locator('#runButton').click();
      await wv.locator('#resultSummary:not(:empty)').first().waitFor({ timeout: 20000 });
      await wv.locator('#copyRequestMenu summary').click();
      const labels = await wv.locator('#copyRequestMenu .menu-items button').allInnerTexts();
      await wv.locator('#copyRequestMenu summary').click();
      for (const wanted of ['Copy as curl', 'Copy as fetch()', 'Copy as .http (REST Client)', 'Copy as Postman collection', 'Copy as TypeScript', 'Save as .http file…'])
        assert(labels.includes(wanted), `missing "${wanted}" in ${JSON.stringify(labels)}`);
      return labels.join(' | ');
    }
  );

  await s.step(
    J,
    'copy as .http: the request is complete, has host and token variables and no secret',
    'one request, POST to _find, body equal to the find, nothing secret on the clipboard',
    async () => {
      await writeClipboard(s, 'sentinel');
      const clip = await copyAs('Copy as .http (REST Client)', { auth: true });
      const token = await mockToken(mock);
      const parsed = parseHttp(clip, { token: 'x' });
      assert(parsed.requests === 1, `${parsed.requests} requests in the file`);
      assert(/^@host = http:\/\/127\.0\.0\.1:\d+$/m.test(clip), `no host variable: ${clip.slice(0, 120)}`);
      assert(/^@token = <session token>$/m.test(clip), 'no token variable');
      assert(parsed.method === 'POST' && parsed.url.endsWith('/databases/Quality/layouts/Customers/_find'), `${parsed.method} ${parsed.url}`);
      assert(parsed.headers.Authorization === 'Bearer x', `Authorization: ${parsed.headers.Authorization}`);
      assert(JSON.stringify(JSON.parse(parsed.body).query) === JSON.stringify(JSON.parse(find)), `body: ${parsed.body}`);
      assert(!clip.includes(PASSWORD) && !clip.includes(token) && !/Basic\s+[A-Za-z0-9+/=]{6,}/.test(clip), 'a secret is on the clipboard');
      // Replay it: what the file means, with the variables filled in, against the mock.
      const replay = parseHttp(clip, { token });
      const response = await fetch(replay.url, { method: replay.method, headers: replay.headers, body: replay.body });
      const json = await response.json();
      assert(response.status === 200 && found(json) === found(expected), `replay: ${response.status} found ${found(json)} vs ${found(expected)}`);
      assert(json.response.data[0].fieldData.CustomerID === 'C-0001', 'replay returned a different record');
      return `replayed .http: HTTP ${response.status}, found ${found(json)}`;
    }
  );

  await s.step(
    J,
    'copy as curl and run it with the real curl',
    'the answer equals the extension\'s own find; the token comes from $FM_TOKEN, not the clipboard',
    async () => {
      const probe = spawnSync('curl', ['--version'], { encoding: 'utf8' });
      if (probe.status !== 0) return { result: 'NOTE', detail: 'curl is not installed on this machine' };
      const clip = await copyAs('Copy as curl', { auth: true });
      const token = await mockToken(mock);
      assert(clip.includes('"Authorization: Bearer $FM_TOKEN"'), `no $FM_TOKEN: ${clip.slice(0, 200)}`);
      assert(!clip.includes(token) && !clip.includes(PASSWORD), 'a secret is in the curl command');
      const run = spawnSync('sh', ['-c', clip], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, FM_TOKEN: token },
        timeout: 30000
      });
      assert(run.status === 0, `curl failed: ${run.stderr}`);
      const json = JSON.parse(run.stdout);
      assert(JSON.stringify(json.response.data) === JSON.stringify(expected.response.data), 'curl got different records than the extension');
      assert(found(json) === found(expected), `found ${found(json)} vs ${found(expected)}`);
      // The same command without the opt-in sends a redacted token: the server must refuse it.
      const redacted = await copyAs('Copy as curl', { auth: false });
      assert(redacted.includes("'Authorization: Bearer <REDACTED>'"), 'the default is not redacted');
      const refused = spawnSync('sh', ['-c', redacted], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30000 });
      assert(JSON.parse(refused.stdout).messages?.[0]?.code === '952', `the redacted copy was accepted: ${refused.stdout.slice(0, 120)}`);
      return `real curl: found ${found(json)}; the redacted copy is refused with 952`;
    }
  );

  await s.step(
    J,
    'copy as Postman, fetch() and TypeScript',
    'each is complete, valid for its tool and holds no secret',
    async () => {
      const token = await mockToken(mock);
      const postman = JSON.parse(await copyAs('Copy as Postman collection'));
      assert(postman.info.schema.endsWith('/v2.1.0/collection.json'), 'not a v2.1 collection');
      assert(postman.variable.some((v) => v.key === 'baseUrl' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v.value)), 'no baseUrl variable');
      assert(postman.item[0].request.url.startsWith('{{baseUrl}}/fmi/data/'), `url: ${postman.item[0].request.url}`);
      const fetchText = await copyAs('Copy as fetch()');
      assert(fetchText.startsWith('const response = await fetch('), 'not a fetch() snippet');
      const ts = await copyAs('Copy as TypeScript');
      assert(/async function dataApi<T>/.test(ts) && ts.includes('"POST"'), 'not the typed wrapper');
      for (const text of [JSON.stringify(postman), fetchText, ts])
        assert(!text.includes(PASSWORD) && !text.includes(token), 'a secret is in a copied request');
      return 'Postman v2.1, fetch(), TypeScript';
    }
  );

  await s.step(
    J,
    'Save as .http file opens an unsaved editor and writes nothing into the workspace',
    'an Untitled editor with the request; no new file in the workspace folder',
    async () => {
      const before = fs.readdirSync(s.ws).sort();
      await wv.locator('#copyRequestMenu summary').click();
      await wv.getByRole('button', { name: 'Save as .http file…', exact: true }).click();
      await s.page.waitForTimeout(1500);
      const tabs = await s.editorTabs();
      assert(tabs.some((t) => /Untitled/i.test(t)), `tabs: ${tabs.join(', ')}`);
      const editorText = await s.page.locator('.monaco-editor .view-lines').first().innerText();
      assert(/###/.test(editorText) && /_find/.test(editorText), `editor shows: ${editorText.slice(0, 120)}`);
      assert(JSON.stringify(fs.readdirSync(s.ws).sort()) === JSON.stringify(before), 'a file appeared in the workspace');
      return tabs.join(', ');
    }
  );
  await s.closeAllEditors();

  await s.step(
    J,
    'a layout name with / % and ? is percent-encoded and works against the server',
    'the copied curl finds records on the mock layout "A/B", "Percent%20Layout" and "Question?Mark"',
    async () => {
      const probe = spawnSync('curl', ['--version'], { encoding: 'utf8' });
      if (probe.status !== 0) return { result: 'NOTE', detail: 'curl is not installed on this machine' };
      const w = await openQueryBuilder(s, 'Customers');
      const options = await w.locator('#layoutSelect option').allInnerTexts();
      const names = ['A/B', 'Percent%20Layout', 'Question?Mark'].filter((n) => options.includes(n));
      if (names.length === 0) return { result: 'NOTE', detail: `the mock lists none of the awkward layouts: ${options.slice(0, 6).join(', ')}` };
      const token = await mockToken(mock);
      const out = [];
      for (const name of names) {
        await w.locator('#layoutSelect').selectOption({ label: name });
        await w.locator('#jsonTab').click();
        await w.locator('#findJson').fill('[{"Name":"probe-*"}]');
        await w.locator('#runButton').click();
        await w.locator('#resultSummary:not(:empty)').first().waitFor({ timeout: 20000 });
        await w.locator('#copyRequestMenu summary').click();
        const box = w.locator('#includeAuthCheckbox');
        if (!(await box.isChecked())) await box.check();
        await w.getByRole('button', { name: 'Copy as curl', exact: true }).click();
        await s.page.waitForTimeout(700);
        const clip = await readClipboard(s);
        assert(clip.includes(`/layouts/${encodeURIComponent(name)}/_find`), `address for ${name}: ${clip.slice(0, 200)}`);
        const run = spawnSync('sh', ['-c', clip], { encoding: 'utf8', env: { PATH: process.env.PATH, FM_TOKEN: token }, timeout: 30000 });
        const json = JSON.parse(run.stdout);
        assert(json.messages?.[0]?.code === '0', `${name}: ${run.stdout.slice(0, 160)}`);
        out.push(`${name} -> found ${found(json)}`);
      }
      await s.closeAllEditors();
      return out.join(' | ');
    }
  );

  await s.step(
    J,
    'the Copy request menus open inside a narrow panel in all four panels and a click copies',
    'at ~360 and ~480 px every item of the open menu is inside the panel and Copy puts a request on the clipboard',
    async () => {
      const recordId = String(expected.response.data[0].recordId);
      const productId = (await mock.manifest()).databases.Quality.tables.Products.conditions.clean[2];
      const original = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      const setWidth = async (width) => {
        await s.app.evaluate(
          ({ BrowserWindow }, [w, h]) => {
            const win = BrowserWindow.getAllWindows()[0];
            win.setMinimumSize(300, 300);
            win.setBounds({ x: 20, y: 20, width: w, height: h });
          },
          [width, 900]
        );
        await s.page.waitForTimeout(900);
      };
      const panels = [
        {
          name: 'Query Builder',
          menu: '#copyRequestMenu',
          copy: '#copyCurlButton',
          open: async () => {
            const w = await openQueryBuilder(s, 'Customers');
            await w.locator('#jsonTab').click();
            await w.locator('#findJson').fill(find);
            await w.locator('#runButton').click();
            await w.locator('#resultSummary:not(:empty)').first().waitFor({ timeout: 20000 });
            return w;
          }
        },
        {
          name: 'Script Runner',
          menu: '#copyRequestMenu',
          copy: '#copyCurlButton',
          open: async () => {
            await s.closeAllEditors();
            await s.cmd('FileMaker: Open Script Runner');
            await answerPickers(s, ['Mock Quality', 'Customers']);
            if (await s.pickerOpen()) await s.inputBox('');
            const w = await s.webview('#scriptNameInput');
            await w.locator('#scriptNameInput').fill('Echo');
            return w;
          }
        },
        {
          name: 'Record Viewer',
          menu: '#copyRecordMenu',
          copy: '#copyRecordButton',
          open: async () => {
            await s.closeAllEditors();
            await s.cmd('FileMaker: Open Record Viewer');
            await answerPickers(s, ['Mock Quality', 'Customers']);
            if (await s.pickerOpen()) await s.inputBox(recordId);
            const w = await s.webview('#relatedDataContainer', { visible: false });
            await w.locator('#loadButton').click();
            await s.page.waitForTimeout(1500);
            return w;
          }
        },
        {
          name: 'Record Editor',
          menu: '#copyRecordMenu',
          copy: '#copyRecordButton',
          open: async () => {
            await s.closeAllEditors();
            await s.cmd('FileMaker: Open Record Editor');
            await answerPickers(s, ['Mock Quality', 'Products']);
            if (await s.pickerOpen()) await s.inputBox(String(productId));
            const w = await s.webview('#recordIdInput');
            const loaded = await w
              .locator('#fieldEditor textarea')
              .first()
              .waitFor({ timeout: 8000 })
              .then(
                () => true,
                () => false
              );
            if (!loaded) await w.locator('#loadButton').click();
            await w.locator('#fieldEditor textarea').first().waitFor({ timeout: 20000 });
            return w;
          }
        }
      ];
      const report = [];
      try {
        for (const width of [360, 480]) {
          for (const panel of panels) {
            const w = await panel.open();
            // As in J14: sidebar closed, and the window is the editor width plus the activity bar.
            await s.cmd('View: Close Primary Side Bar').catch(() => {});
            await setWidth(width + 52);
            await w.locator(`${panel.menu} summary`).click();
            // A wide <select> (the 140-character layout name of the mock) can stretch a page sideways, a separate
            // known finding of J14; look at the menu from the left edge of the page.
            await w.locator('body').evaluate(() => window.scrollTo(0, 0));
            await s.page.waitForTimeout(300);
            const box = await w.locator(`${panel.menu} .menu-items`).evaluate((el) => {
              const vw = document.documentElement.clientWidth;
              const items = [...el.querySelectorAll('button, select')].map((item) => {
                const r = item.getBoundingClientRect();
                return { id: item.id, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
              });
              const r = el.getBoundingClientRect();
              return { vw, left: Math.round(r.left), right: Math.round(r.right), items };
            });
            const outside = box.items.filter((item) => item.width <= 0 || item.left < 0 || item.right > box.vw + 1);
            assert(
              box.left >= 0 && box.right <= box.vw + 1 && outside.length === 0,
              `${panel.name} at ${width}px: menu ${box.left}..${box.right} of ${box.vw}; outside: ${JSON.stringify(outside)}`
            );
            await writeClipboard(s, 'sentinel');
            await w.locator(`${panel.menu} ${panel.copy}`).click();
            await s.page.waitForTimeout(700);
            const clip = await readClipboard(s);
            assert(/^curl -X /.test(clip), `${panel.name} at ${width}px copied: ${clip.slice(0, 80)}`);
            report.push(`${panel.name}@${width}`);
          }
        }
      } finally {
        await s.app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), original);
        await s.page.waitForTimeout(500);
        await s.closeAllEditors();
      }
      return report.join(', ');
    }
  );

  await s.step(
    J,
    'the command palette command asks operation, layout, record and format',
    'FileMaker: Copy Request as Code… copies a get-record curl for the chosen record',
    async () => {
      await s.closeAllEditors();
      const id = expected.response.data[0].recordId;
      await writeClipboard(s, 'sentinel');
      await s.cmd('FileMaker: Copy Request as Code…');
      await s.pick('Get one record');
      await s.pick('Customers');
      await s.inputBox(String(id), { timeout: 10000 });
      await s.pick('curl');
      await s.page.waitForTimeout(800);
      const clip = await readClipboard(s);
      assert(clip.includes(`/layouts/Customers/records/${id}`) && clip.startsWith('curl -X GET '), `clipboard: ${clip.slice(0, 160)}`);
      const token = await mockToken(mock);
      const probe = spawnSync('curl', ['--version'], { encoding: 'utf8' });
      if (probe.status === 0) {
        const withAuth = clip.replace("'Authorization: Bearer <REDACTED>'", '"Authorization: Bearer $FM_TOKEN"');
        const run = spawnSync('sh', ['-c', withAuth], { encoding: 'utf8', env: { PATH: process.env.PATH, FM_TOKEN: token }, timeout: 30000 });
        assert(JSON.parse(run.stdout).response.data[0].fieldData.CustomerID === 'C-0001', `record: ${run.stdout.slice(0, 120)}`);
      }
      return clip.slice(0, 120);
    }
  );
  await s.closeAllEditors();
}
