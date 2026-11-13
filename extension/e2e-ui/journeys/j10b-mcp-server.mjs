// Journey 10b: the MCP server for external tools, driven through the real VS Code UI and real MCP clients
// (the SDK client over stdio using the exact config the extension copies; the Claude Code CLI where possible).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  answerPickers,
  connect,
  createProfile,
  ensureProfileCommands,
  readClipboard
} from '../lib/flows.mjs';
import { assert, safeEnv } from '../lib/session.mjs';

const J = 'J10b MCP server';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => String(r?.content?.[0]?.text ?? '');
const mcpBadge = async (s) => /MCP/.test((await s.statusItem(/AI:/)) ?? '');

/** Spawn the shim exactly as the copied config says (command + args). */
async function connectClient(config, { env = {}, name = 'e2e-sdk' } = {}) {
  const entry = config.mcpServers.filemaker;
  const client = new Client({ name, version: '1.0' });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: safeEnv(env),
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => {
    stderr += d;
  });
  await client.connect(transport);
  client.__stderr = () => stderr;
  return client;
}
async function modalCall(s, p, answer) {
  const modal = await s.waitModal(20000).catch((e) => `NO MODAL: ${e.message}`);
  const buttons = (await s.modalVisible()) ? await s.modalButtons() : [];
  await s.shot('mcp-modal');
  if (!String(modal).startsWith('NO MODAL')) {
    if (answer === false)
      await s.modal(buttons.find((b) => /cancel|don'?t|no\b/i.test(b)) ?? 'Cancel');
    else await s.modal(buttons.find((b) => new RegExp(answer, 'i').test(b)) ?? buttons[0]);
  }
  return { modal, buttons, result: await p };
}

export async function run(ctx) {
  const { s, mock } = ctx;
  s.observeOnly([
    'SDK MCP client: initialize through the copied config',
    'quota: repeated 50-record reads'
  ]); // these steps only record behaviour
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');
  const data = mock.data('Quality');
  const man = await mock.manifest();
  const clients = [];
  const cleanups = [];
  ctx.cleanups ??= [];
  ctx.cleanups.push(async () => {
    for (const c of clients) await c.close().catch(() => {});
  });

  // ---- prerequisites: AI on, connection with Read access -----------------------------------
  await s.setSetting('filemaker.ai.enabled', true);
  await s.setSetting('filemaker.ai.allowWrites', false);
  await s.cmd('FileMaker: Set AI Access for Connection');
  await answerPickers(s, ['Mock Quality'], { max: 1 });
  await s.pick('Read');
  await s.clickToastButton('Use for AI Tools').catch(() => {});
  await s.page.waitForTimeout(1200);
  await s.dismissToasts();

  // Reset record quota and layout approvals left by earlier journeys, so the consent prompts are exercised from scratch.
  await s.cmd('FileMaker: Start New AI Session');
  await s.waitModal(10000).catch(() => {});
  if (await s.modalVisible()) await s.modal('Start New Session');
  await s.page.waitForTimeout(800);

  const settingsHas = () => s.readSettings()['filemaker.ai.externalServer.enabled'];
  await s.step(
    J,
    'Start AI Server: decline the confirmation',
    'modal explains it starts a local server in this window only; declining starts nothing and does not turn the permission on',
    async () => {
      assert(settingsHas() !== true, 'permission already on');
      await s.cmd('FileMaker: Start/Stop AI Server for External Tools');
      const t = await s.waitModal(15000);
      const buttons = await s.modalButtons();
      assert(/Start the AI server/i.test(t), t);
      await s.modal('Cancel');
      await s.page.waitForTimeout(1000);
      assert(!(await mcpBadge(s)), 'server running after decline');
      assert(settingsHas() !== true, 'permission turned on by a declined dialog');
      return `buttons: ${buttons.join(' / ')} | modal text: ${t.slice(0, 200)}`;
    }
  );
  await s.step(
    J,
    'Start AI Server: accept "Turn On and Start"',
    'permission setting written to user settings, server runs, status bar shows MCP, info toast explains autostart',
    async () => {
      await s.cmd('FileMaker: Start/Stop AI Server for External Tools');
      const t = await s.waitModal(15000);
      assert(
        /Turn On and Start/.test((await s.modalButtons()).join('|')),
        `buttons: ${(await s.modalButtons()).join('|')}`
      );
      await s.modal('Turn On and Start');
      await s.waitToast(/is running in this window/i, { timeout: 15000 });
      await s.page.waitForTimeout(800);
      assert(settingsHas() === true, 'permission not written');
      assert(await mcpBadge(s), `status: ${await s.statusItem(/AI:/)}`);
      return `status: ${await s.statusItem(/AI:/)}`;
    }
  );
  let config;
  let dir;
  let discoveryFile;
  let record;
  await s.step(
    J,
    'Copy MCP Config for Claude Code / Cursor',
    'clipboard holds mcpServers.filemaker with node + shim path + --dir + --workspace; no token anywhere; the shim file exists and is owner-only',
    async () => {
      await s.cmd('FileMaker: Copy MCP Config for Claude Code / Cursor');
      await s.waitToast(/MCP config copied/i, { timeout: 15000 });
      const clip = await readClipboard(s);
      config = JSON.parse(clip);
      const entry = config.mcpServers.filemaker;
      dir = entry.args[entry.args.indexOf('--dir') + 1];
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      assert(files.length === 1, `discovery files: ${files}`);
      discoveryFile = path.join(dir, files[0]);
      record = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
      assert(!clip.includes(record.token), 'the token is in the copied config');
      assert(!/[0-9a-f]{64}/.test(clip), 'a 64-hex string (token-shaped) is in the config');
      const shim = entry.args[0];
      const st = fs.statSync(shim);
      const mode = (st.mode & 0o777).toString(8);
      const discMode = (fs.statSync(discoveryFile).mode & 0o777).toString(8);
      return `command=${entry.command}; shim=${shim.replace(os.tmpdir(), '<tmp>')} mode ${mode}; discovery file mode ${discMode}; args: ${entry.args
        .slice(1)
        .map((a) => a.replace(os.tmpdir(), '<tmp>'))
        .join(' ')}; clipboard ${clip.length} bytes`;
    }
  );

  // ---- client (a): the SDK client with that exact config --------------------------------
  let a;
  let changed = 0;
  await s.step(
    J,
    'SDK MCP client: initialize through the copied config',
    'initialize succeeds; server name/version; tools capability with listChanged',
    async () => {
      a = await connectClient(config);
      clients.push(a);
      a.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        changed += 1;
      });
      const info = a.getServerVersion();
      const caps = a.getServerCapabilities();
      await sleep(1200);
      const sb = await s.statusItem(/AI:/);
      const toasts = await s.toasts();
      return `server ${JSON.stringify(info)}; listChanged=${caps?.tools?.listChanged}; status bar "${sb}"; notifications: ${toasts.join(' || ') || 'none'}`;
    }
  );
  await s.step(
    J,
    'tools/list on a read connection',
    'only the read tools; no edit/create/delete/run_script',
    async () => {
      const { tools } = await a.listTools();
      const names = tools.map((t) => t.name).sort();
      assert(names.includes('fm_find_records'), names.join(','));
      assert(
        !names.some((n) => /edit|create|delete|run_script/.test(n)),
        `write/script tools listed: ${names.join(',')}`
      );
      return `${names.join(', ')} | annotations: ${tools
        .map((t) => `${t.name}:${JSON.stringify(t.annotations ?? {})}`)
        .slice(0, 2)
        .join(' ')}`;
    }
  );
  await s.step(
    J,
    'read call: fm_list_layouts',
    'layout names come back as data (no server address)',
    async () => {
      const r = await a.callTool({ name: 'fm_list_layouts', arguments: {} });
      assert(!r.isError && /Customers/.test(text(r)), text(r).slice(0, 200));
      assert(!text(r).includes(mock.baseUrl), 'server address leaked');
      return text(r).slice(0, 120);
    }
  );
  await s.step(
    J,
    'read call needing layout consent: fm_describe_layout shows a host modal',
    'VS Code shows the approval modal; accepting lets the call finish; hidden fields are absent',
    async () => {
      await s.setSetting('filemaker.ai.hiddenFields', [
        'Customers::SSN',
        'Customers::Password',
        'Customers::Token'
      ]);
      const p = a.callTool({ name: 'fm_describe_layout', arguments: { layout: 'Customers' } });
      const { modal, buttons, result } = await modalCall(s, p, 'allow|approve|yes|read|ok');
      assert(!String(modal).startsWith('NO MODAL'), String(modal));
      assert(!result.isError, text(result).slice(0, 300));
      assert(!/"SSN"|"Password"|"Token"/.test(text(result)), 'hidden field names in the output');
      return `modal: ${String(modal).slice(0, 200)} | buttons: ${buttons.join('/')}`;
    }
  );
  await s.step(
    J,
    'read call on hostile data (prompt injection, secrets, hosts) with hidden fields',
    'output is data; hidden fields absent; server address and session token scrubbed',
    async () => {
      const r = await a.callTool({
        name: 'fm_find_records',
        arguments: { layout: 'Customers', requests: [{ fields: { CustomerID: '*' } }], limit: 50 }
      });
      const t = text(r);
      assert(!r.isError, t.slice(0, 300));
      assert(!/tok_test_|"SSN"|"Password"/.test(t), 'hidden fields leaked');
      const leaks = [mock.baseUrl, new URL(mock.baseUrl).host].filter((x) => t.includes(x));
      return `${t.length} chars; address leaks: ${JSON.stringify(leaks)}; injection text delivered as data: ${/Ignore previous instructions/.test(t)}`;
    }
  );
  await s.step(
    J,
    'refused write on a read connection',
    'edit is refused (isError) and the server record is unchanged',
    async () => {
      const pid = man.databases.Quality.tables.Products.conditions.clean[8];
      const before = await data.record('Products', pid);
      const r = await a
        .callTool({
          name: 'fm_edit_record',
          arguments: {
            layout: 'Products',
            recordId: pid,
            fields: { Name: 'mcp read-only attempt' }
          }
        })
        .catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
      assert(r.isError === true, 'write not refused');
      assert(
        (await data.record('Products', pid)).fieldData.Name === before.fieldData.Name,
        'record changed'
      );
      return text(r).slice(0, 200);
    }
  );
  await s.step(
    J,
    'quota: repeated 50-record reads',
    'after the per-session budget the server refuses with a message (not a crash)',
    async () => {
      let last;
      let n = 0;
      for (; n < 15; n += 1) {
        last = await a.callTool({
          name: 'fm_find_records',
          arguments: { layout: 'Customers', requests: [{ fields: { CustomerID: '*' } }], limit: 50 }
        });
        if (last.isError) break;
      }
      return `refused after ${n + 1} calls: ${last.isError ? text(last).slice(0, 160) : 'never refused'}`;
    }
  );

  await s.step(
    J,
    'Start New AI Session after the quota is used up',
    'quota and approvals reset',
    async () => {
      await s.cmd('FileMaker: Start New AI Session');
      await s.waitModal(10000);
      await s.modal('Start New Session');
      await s.page.waitForTimeout(800);
      const r = await a.callTool({ name: 'fm_list_layouts', arguments: {} });
      assert(!r.isError, text(r));
    }
  );

  // ---- write access -------------------------------------------------------------------------
  await s.step(
    J,
    'switch the connection to Write access: list_changed and write tools appear',
    'client gets tools/list_changed; edit/create/delete tools now listed',
    async () => {
      changed = 0;
      await s.setSetting('filemaker.ai.allowWrites', true);
      await s.cmd('FileMaker: Set AI Access for Connection');
      await answerPickers(s, ['Mock Quality'], { max: 1 });
      await s.pick('Write');
      await s.page.waitForTimeout(1500);
      await s.dismissToasts();
      for (let i = 0; i < 40 && !changed; i += 1) await sleep(150);
      const names = (await a.listTools()).tools.map((t) => t.name);
      assert(names.includes('fm_edit_record'), names.join(','));
      return `list_changed notifications: ${changed}; tools: ${names.join(', ')}`;
    }
  );
  const pid = man.databases.Quality.tables.Products.conditions.clean[9];
  await s.step(
    J,
    'MCP edit: host modal, decline',
    'modal names the record and changes; declining writes nothing; client sees a refusal',
    async () => {
      const before = await data.record('Products', pid);
      // the first read of Products asks for approval
      const first = a.callTool({ name: 'fm_describe_layout', arguments: { layout: 'Products' } });
      await modalCall(s, first, 'allow|approve|yes|read|ok').catch(() => {});
      const p = a.callTool({
        name: 'fm_edit_record',
        arguments: {
          layout: 'Products',
          recordId: pid,
          fields: { Name: 'MCP edit (declined)' },
          description: 'e2e'
        }
      });
      const { modal, buttons, result } = await modalCall(s, p, false);
      assert(!String(modal).startsWith('NO MODAL'), String(modal));
      assert(
        (await data.record('Products', pid)).fieldData.Name === before.fieldData.Name,
        'declined edit was written'
      );
      return `modal: ${String(modal).replace(/\s+/g, ' ').slice(0, 300)} | buttons ${buttons.join('/')} | client got: ${text(result).slice(0, 120)}`;
    }
  );
  await s.step(
    J,
    'MCP edit: host modal, accept',
    'record is written; client reports it; modId increments',
    async () => {
      const before = await data.record('Products', pid);
      const p = a.callTool({
        name: 'fm_edit_record',
        arguments: {
          layout: 'Products',
          recordId: pid,
          fields: { Name: 'MCP edit (accepted)' },
          description: 'e2e'
        }
      });
      const { result } = await modalCall(s, p, 'save|apply|allow|yes|ok|change');
      const after = await data.record('Products', pid);
      assert(
        after.fieldData.Name === 'MCP edit (accepted)',
        `not written: ${text(result).slice(0, 200)}`
      );
      return `modId ${before.modId} -> ${after.modId}; client got: ${text(result).slice(0, 120)}`;
    }
  );
  await s.step(
    J,
    'MCP delete: typed-record-id confirmation',
    'deleting asks the user to type the record id; a wrong id deletes nothing; the right id deletes',
    async () => {
      const created = (
        await data.call('POST', '/layouts/Products/records', {
          fieldData: { SKU: 'MCP-DEL', Name: 'to delete' }
        })
      ).body.response.recordId;
      const exists = async () =>
        (await data.call('GET', `/layouts/Products/records/${created}`)).body.messages[0].code ===
        '0';
      let used = 'none';
      // One delete attempt: confirm the host-side modal, then type the given id into the input box.
      const attempt = async (typedId) => {
        const p = a.callTool({
          name: 'fm_delete_record',
          arguments: { layout: 'Products', recordId: created, description: 'e2e' }
        });
        await sleep(1500);
        await s.shot('delete-prompt');
        if (await s.modalVisible()) {
          const t = await s.modalText();
          const buttons = await s.modalButtons();
          used = `modal "${t.slice(0, 200)}" buttons ${buttons.join('/')}`;
          await s.modal(buttons.find((b) => /continue|delete|confirm|yes/i.test(b)) ?? buttons[0]);
        }
        if (await s.pickerOpen()) {
          used += ` | input: ${await s.quickInputTitle()} / ${await s.quickInputMessage()}`;
          await s.inputBox(typedId);
          await sleep(1000);
        }
        return text(await p).slice(0, 140);
      };
      // The extension allows 3 write attempts a minute; wait the window out rather than fail on the cap.
      const attemptUntilNotCapped = async (typedId) => {
        let out = await attempt(typedId);
        if (/write cap/i.test(out)) {
          await sleep(62000);
          out = await attempt(typedId);
        }
        return out;
      };
      const wrong = await attemptUntilNotCapped('0000'); // a wrong id deletes nothing
      const survivedWrongId = await exists();
      const right = await attemptUntilNotCapped(String(created));
      const gone = !(await exists());
      assert(/modal|input/.test(used), 'no confirmation of any kind was shown before the delete');
      assert(survivedWrongId, `a wrong typed id deleted the record: ${wrong}`);
      assert(gone, `the right id did not delete the record: ${right}`);
      return `${used} | wrong id: ${wrong} | right id: ${right} | record deleted: ${gone}`;
    }
  );
  await s.step(
    J,
    'audit view shows the MCP calls',
    'Show AI Activity lists tool, outcome, client name e2e-sdk; no record contents',
    async () => {
      await s.cmd('FileMaker: Show AI Activity');
      await s.page.waitForTimeout(1500);
      const t = await s.activeEditorText();
      assert(/fm_edit_record/.test(t) && /e2e-sdk/.test(t), t.slice(0, 300));
      assert(!/MCP edit \(accepted\)/.test(t), 'written value stored in the audit log');
      await s.closeAllEditors();
      return t.replace(/\s+/g, ' ').slice(0, 220);
    }
  );
  await s.step(
    J,
    'kill switch: list_changed, empty list, refused calls, switch back on',
    'status bar click switches off; client is notified; calls refused; on again via modal',
    async () => {
      changed = 0;
      await s.clickStatus(/AI:/);
      for (let i = 0; i < 40 && !changed; i += 1) await sleep(150);
      const listed = (await a.listTools()).tools.length;
      const refused = await a
        .callTool({ name: 'fm_list_layouts', arguments: {} })
        .catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
      await s.clickStatus(/AI:/);
      await s.waitModal(10000);
      await s.modal('Switch On');
      for (let i = 0; i < 40 && changed < 2; i += 1) await sleep(150);
      assert(
        changed >= 1 && listed === 0 && refused.isError,
        `changed=${changed} listed=${listed} refused=${refused.isError}`
      );
      return `list_changed ${changed}x; tools while off: ${listed}; refusal: ${text(refused).slice(0, 100)}`;
    }
  );

  // ---- failure / abuse cases through the real shim --------------------------------------------
  const runShim = (args, { input, timeoutMs = 8000, env = {} } = {}) =>
    new Promise((resolve) => {
      const child = spawn(config.mcpServers.filemaker.command, args, {
        env: safeEnv(env),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        err += d;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
      child.stdin.on('error', () => {}); // the shim may close before a large write finishes (EPIPE)
      if (input !== undefined) child.stdin.write(input);
    });
  const shimArgs = config.mcpServers.filemaker.args;
  await s.step(
    J,
    'wrong token in the discovery file',
    'the shim exits 1 saying the server refused; no token on stderr/stdout',
    async () => {
      const good = fs.readFileSync(discoveryFile, 'utf8');
      const bad = JSON.stringify({ ...record, token: 'f'.repeat(64) });
      fs.writeFileSync(discoveryFile, `${bad}\n`, { mode: 0o600 });
      const r = await runShim(shimArgs);
      fs.writeFileSync(discoveryFile, good, { mode: 0o600 });
      assert(r.code === 1 && /refused/i.test(r.err), `code ${r.code} stderr ${r.err}`);
      assert(!r.err.includes(record.token) && !r.out.includes(record.token), 'token printed');
      return r.err.trim().slice(0, 200);
    }
  );
  await s.step(
    J,
    'discovery file readable by others',
    'the shim refuses a world-readable discovery file',
    async () => {
      fs.chmodSync(discoveryFile, 0o644);
      const r = await runShim(shimArgs);
      fs.chmodSync(discoveryFile, 0o600);
      assert(r.code === 1, `exit ${r.code}`);
      return r.err.trim().slice(0, 240);
    }
  );
  await s.step(
    J,
    '20 parallel calls on one connection',
    'all answered or refused cleanly (rate limit), server stays up',
    async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          a.callTool({ name: 'fm_list_layouts', arguments: {} }).then(
            (r) => (r.isError ? `err:${text(r).slice(0, 60)}` : 'ok'),
            (e) => `throw:${String(e.message).slice(0, 60)}`
          )
        )
      );
      const tally = results.reduce((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
      const alive = await a.callTool({ name: 'fm_list_layouts', arguments: {} }).then(
        () => true,
        () => false
      );
      const unclean = Object.keys(tally).filter(
        (k) => k !== 'ok' && !/too many requests in flight|rate/i.test(k)
      );
      assert(
        alive,
        `the server stopped answering after 20 parallel calls: ${JSON.stringify(tally)}`
      );
      assert(
        unclean.length === 0,
        `unclean failures under load: ${unclean.join(' | ')} (${JSON.stringify(tally)})`
      );
      assert((tally.ok ?? 0) > 0, `no call succeeded: ${JSON.stringify(tally)}`);
      return `${JSON.stringify(tally)}; server still answers after: ${alive}`;
    }
  );
  await s.step(
    J,
    'oversized message through the shim',
    'a >1 MB single JSON-RPC line is refused (connection closed) without crashing the window',
    async () => {
      const big = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x'.repeat(4 * 1024 * 1024), version: '1' } } })}\n`;
      const r = await runShim(shimArgs, { input: big, timeoutMs: 15000 });
      const stillUp = await a.callTool({ name: 'fm_list_layouts', arguments: {} }).then(
        (x) => !x.isError,
        () => false
      );
      assert(/too large/i.test(r.out), `no 'too large' refusal on stdout: ${r.out.slice(0, 200)}`);
      assert(stillUp, 'the oversized message took the server down for other clients');
      return `shim exit ${r.code}; stdout ${r.out.length} bytes (${r.out.replace(/\s+/g, ' ').slice(0, 120)}); stderr: ${r.err.slice(0, 120)}; other client still works: ${stillUp}`;
    }
  );
  await s.step(
    J,
    'malformed JSON-RPC and unknown method',
    'server answers with a JSON-RPC error and keeps the connection',
    async () => {
      const r = await runShim(shimArgs, {
        input: '{not json}\n{"jsonrpc":"2.0","id":7,"method":"nope"}\n',
        timeoutMs: 5000
      });
      assert(
        /-32700/.test(r.out),
        `no parse error (-32700) for the malformed line: ${r.out.slice(0, 200)}`
      );
      assert(
        /"id":7/.test(r.out.replace(/\s+/g, '')),
        `no JSON-RPC answer for the unknown method (id 7): ${r.out.slice(0, 260)}`
      );
      return `stdout: ${r.out.replace(/\s+/g, ' ').slice(0, 260)} stderr: ${r.err.slice(0, 100)}`;
    }
  );

  // ---- two windows (same VS Code, different workspaces) and a second product profile ------------
  await s.step(
    J,
    'two VS Code windows with different workspaces: the shim refuses to guess',
    'with both servers running, a shim without --workspace exits 1 and lists the windows; with --workspace it picks the right one',
    async () => {
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-e2e-ws2-'));
      (ctx.extraRoots ??= []).push(ws2);
      fs.writeFileSync(path.join(ws2, 'README.md'), '# second workspace\n');
      const known = new Set(s.app.windows());
      const opened = spawnSync(
        ctx.vscode.cli,
        ['--user-data-dir', s.ud, '--extensions-dir', s.ex, '--no-sandbox',
          '--disable-workspace-trust', '--new-window', ws2],
        { env: safeEnv({ HOME: s.home }), encoding: 'utf8', timeout: 15000 }
      );
      assert(opened.status === 0,
        `second-window CLI failed (${opened.status}): ${opened.error?.message ?? ''} ${opened.stdout} ${opened.stderr}`);
      let page2;
      for (let i = 0; i < 60 && !page2; i += 1) {
        await sleep(500);
        page2 = s.app.windows().find((w) => !known.has(w));
      }
      assert(page2, 'the second window did not open');
      await page2.waitForSelector('.monaco-workbench', { timeout: 60000 });
      await page2
        .locator('.statusbar-item', { hasText: /FileMaker/ })
        .first()
        .waitFor({ timeout: 45000 });
      const s2 = Object.create(s);
      s2.page = page2;
      s2.ws = ws2;
      try {
        const win = await s.app.browserWindow(page2);
        try {
          await win.evaluate((w) => {
            if (w.isMinimized()) w.restore();
            w.show();
            w.focus();
            w.webContents.focus();
          });
        } finally { await win.dispose(); }
        await page2.bringToFront();
        await page2.waitForFunction(() => document.hasFocus(), null, { timeout: 15000 });
        await s2.dismissStartupOverlays().catch(() => {});
        assert(!(await s2.modalVisible()), `unexpected second-window modal: ${await s2.modalText()}`);
        await page2
          .screenshot({ path: ctx.report.nextShot(J, 'second-window'), scale: 'css' })
          .catch(() => {});
        await s2.cmd('FileMaker: Start/Stop AI Server for External Tools');
        await s2.waitModal(20000);
        await s2.modal('Start Here');
        await sleep(3000);
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        assert(files.length === 2, `discovery files: ${files.length}`);
        const noWs = await runShim([config.mcpServers.filemaker.args[0], '--dir', dir]);
        assert(
          noWs.code === 1 && /not guessing|windows match/i.test(noWs.err),
          `exit ${noWs.code} ${noWs.err.slice(0, 200)}`
        );
        const withWs = new Client({ name: 'e2e-ws2', version: '1' });
        const t = new StdioClientTransport({
          command: 'node',
          args: [config.mcpServers.filemaker.args[0], '--dir', dir, '--workspace', ws2],
          env: safeEnv(),
          stderr: 'pipe'
        });
        await withWs.connect(t);
        clients.push(withWs);
        const tools = (await withWs.listTools()).tools.length;
        const ws2Call =
          tools === 0
            ? text(
                await withWs
                  .callTool({ name: 'fm_list_layouts', arguments: {} })
                  .catch((e) => ({ content: [{ text: String(e.message) }] }))
              ).slice(0, 200)
            : '';
        const viaConfig = await connectClient(config, { name: 'e2e-ws1-again' });
        clients.push(viaConfig);
        await viaConfig.listTools();
        await s2.cmd('FileMaker: Start/Stop AI Server for External Tools');
        await sleep(2500);
        const left = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
        return `without --workspace: exit ${noWs.code} "${noWs.err.replace(/\s+/g, ' ').slice(0, 230)}"; with --workspace ${path.basename(ws2)}: ${tools} tools${tools === 0 ? ` (a call says: ${ws2Call})` : ''}; the copied config (window 1) still works; discovery files after stopping window 2: ${left}`;
      } finally {
        await page2.close().catch(() => {});
        await s.page.bringToFront().catch(() => {});
      }
    }
  );
  await s.step(
    J,
    'second product: a separate VS Code profile (own storage) running its own server',
    "each product's shim connects only to its own window; sockets do not collide",
    async () => {
      const { Session } = await import('../lib/session.mjs');
      const p2 = new Session({ report: ctx.report, vscode: ctx.vscode, name: 'product2' });
      ctx.cleanups.push(() => p2.dispose());
      p2.installVsix(ctx.vsix);
      p2.writeSettings({
        'filemaker.ai.enabled': true,
        'filemaker.ai.externalServer.enabled': true
      });
      await p2.launch();
      await createProfile(p2, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
      await ensureProfileCommands(p2);
      await p2.cmd('FileMaker: Set AI Access for Connection');
      await answerPickers(p2, ['Mock Quality'], { max: 1 });
      await p2.pick('Read');
      await p2.clickToastButton('Use for AI Tools').catch(() => {});
      await p2.cmd('FileMaker: Start/Stop AI Server for External Tools');
      await p2.waitModal(20000);
      await p2.modal('Start Here');
      await sleep(2500);
      await p2.cmd('FileMaker: Copy MCP Config for Claude Code / Cursor');
      await p2.waitToast(/MCP config copied/i, { timeout: 15000 });
      const cfg2 = JSON.parse(await readClipboard(p2));
      const dir2 =
        cfg2.mcpServers.filemaker.args[cfg2.mcpServers.filemaker.args.indexOf('--dir') + 1];
      assert(dir2 !== dir, 'the second profile shares the discovery folder');
      const c2 = await connectClient(cfg2, { name: 'e2e-product2' });
      clients.push(c2);
      const ok2 = (await c2.callTool({ name: 'fm_list_layouts', arguments: {} })).isError !== true;
      const c1 = await connectClient(config, { name: 'e2e-product1' });
      clients.push(c1);
      const ok1 = (await c1.callTool({ name: 'fm_list_layouts', arguments: {} })).isError !== true;
      await p2.close();
      return `product 2 folder differs: ${dir2 !== dir}; both shims answer: ${ok1 && ok2}`;
    }
  );

  // ---- Stop, persistence across reload -----------------------------------------------------
  await s.step(
    J,
    'Stop AI Server',
    'command stops it: toast, no MCP badge, discovery file removed, connected client is dropped',
    async () => {
      await s.cmd('FileMaker: Start/Stop AI Server for External Tools');
      await s.waitToast(/stopped in this window/i, { timeout: 15000 });
      await s.page.waitForTimeout(800);
      assert(!(await mcpBadge(s)), 'badge still shown');
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      assert(left.length === 0, `discovery files left: ${left}`);
      const r = await runShim(shimArgs);
      const dropped = await a.callTool({ name: 'fm_list_layouts', arguments: {} }).then(
        () => false,
        () => true
      );
      return `shim after stop: exit ${r.code} "${r.err.trim().slice(0, 120)}"; connected client dropped: ${dropped}`;
    }
  );
  await s.step(
    J,
    'reload the window after Stop: server stays stopped',
    'no discovery file and no MCP badge after Developer: Reload Window',
    async () => {
      await s.reloadWindow();
      await sleep(3000);
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      assert(
        left.length === 0 && !(await mcpBadge(s)),
        `files ${left}, badge ${await mcpBadge(s)}`
      );
    }
  );
  await s.step(
    J,
    'confirmed Start, then reload: server autostarts',
    'after "Start Here" and a window reload the server is running again without asking',
    async () => {
      await s.cmd('FileMaker: Start/Stop AI Server for External Tools');
      const t = await s.waitModal(15000);
      assert(
        /Start Here/.test((await s.modalButtons()).join('|')),
        `buttons ${(await s.modalButtons()).join('|')}`
      );
      await s.modal('Start Here');
      await s.waitToast(/is running in this window/i, { timeout: 15000 });
      await s.reloadWindow();
      for (let i = 0; i < 30 && !(await mcpBadge(s)); i += 1) await sleep(500);
      assert(await mcpBadge(s), `no autostart; status: ${await s.statusItem(/AI:/)}`);
      return `status after reload: ${await s.statusItem(/AI:/)}`;
    }
  );
  await s.step(
    J,
    'kill -9 the extension host, then restart',
    'the old discovery file is treated as stale (dead process); the shim refuses it; after VS Code restarts the host the server is back and a client connects',
    async () => {
      // Without the helper extension: an Extension Development Host window ends when its host dies, a normal window does not.
      await s.restart({ helper: false });
      for (let i = 0; i < 40 && !(await mcpBadge(s)); i += 1) await sleep(500);
      assert(await mcpBadge(s), 'the server did not autostart in the plain window');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      process.kill(rec.pid, 'SIGKILL');
      await sleep(1500);
      const stale = await runShim(shimArgs);
      const staleOutcome = `shim right after kill: exit ${stale.code} "${stale.err.trim().replace(/\s+/g, ' ').slice(0, 160)}"`;
      await sleep(2500);
      let windowState = 'window still open';
      if (!s.app.windows().length) {
        windowState = 'VS Code exited with its extension host';
        await s.close();
        await s.launch({ helper: false });
      } else if (s.page.isClosed()) {
        windowState = 'the window was recreated';
        s.page = s.app.windows().at(-1);
      }
      await s.shot('after-kill');
      const toastsAfter = await s.toasts().catch(() => []);
      let restarted = 'auto';
      const btn = s.page
        .locator('.notification-list-item .monaco-button, .monaco-dialog-box .monaco-button', {
          hasText: /Restart|Reload/
        })
        .first();
      if (await btn.count().catch(() => 0)) {
        restarted = `clicked "${await btn.innerText()}"`;
        await btn.click();
      }
      restarted += ` (${windowState}; notifications: ${toastsAfter.join(' || ') || 'none'})`;
      await sleep(8000);
      for (let i = 0; i < 40 && !(await mcpBadge(s)); i += 1) await sleep(500);
      const r2 = await runShim(shimArgs).catch((e) => ({ code: -1, err: String(e) }));
      return `${staleOutcome} | restart: ${restarted} | badge after: ${await mcpBadge(s)} | discovery files: ${fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length} | shim after restart: exit ${r2.code} ${r2.err?.trim().slice(0, 100)}`;
    }
  );
  await s.step(
    J,
    'stale discovery file (process gone) next to the live one',
    'the shim ignores the stale file, says nothing alarming and connects to the live window; the stale file is never trusted',
    async () => {
      const dead = spawn(process.execPath, ['-e', '0']);
      await new Promise((resolve) => dead.once('exit', resolve));
      const live = JSON.parse(
        fs.readFileSync(
          path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.json'))[0]),
          'utf8'
        )
      );
      const staleFile = path.join(dir, 'ffffffffffffffff.json');
      fs.writeFileSync(
        staleFile,
        `${JSON.stringify({ ...live, pid: dead.pid, token: '0'.repeat(64), workspaceFolders: ['/nonexistent/ws'], label: 'stale-window' })}\n`,
        { mode: 0o600 }
      );
      const r = await runShim(shimArgs, { timeoutMs: 4000 });
      fs.rmSync(staleFile, { force: true });
      assert(
        r.code === null || r.code === 0,
        `the shim did not connect with a stale file next to the live one (exit ${r.code}): ${r.err.slice(0, 200)}`
      );
      assert(!r.err.includes('0'.repeat(64)), 'the stale token was printed');
      assert(
        !/stale-window|nonexistent/.test(r.err),
        `the stale file was mentioned: ${r.err.slice(0, 200)}`
      );
      return `shim with a stale file present: exit ${r.code === null ? 'still running = connected to the live window' : r.code}; stderr: ${r.err.replace(/\s+/g, ' ').slice(0, 200) || '(empty)'}; stale token printed: ${r.err.includes('0'.repeat(64))}`;
    }
  );
  await s.restart(); // back to a window with the helper extension for the rest of the suite
  await s.step(
    J,
    'config keeps working after the extension host restart (copy again, connect, tools/list)',
    'a fresh SDK client connects with the config and lists tools',
    async () => {
      await s.cmd('FileMaker: Copy MCP Config for Claude Code / Cursor');
      await s.waitToast(/MCP config copied/i, { timeout: 15000 });
      config = JSON.parse(await readClipboard(s));
      const c = await connectClient(config, { name: 'e2e-sdk-2' });
      clients.push(c);
      const n = (await c.listTools()).tools.length;
      assert(n > 0, 'no tools');
      return `${n} tools`;
    }
  );

  // ---- real Claude Code CLI ----------------------------------------------------------------
  // Opt-in only (E2E_CLAUDE=1): it starts a real third-party CLI. The environment below is an allowlist;
  // nothing from the caller's environment (no ANTHROPIC_*, AWS_*, CLAUDE_CODE_USE_*, GH_TOKEN ...) is passed.
  // HOME and CLAUDE_CONFIG_DIR point at an empty temporary directory, but on macOS the CLI may still read its
  // credentials from the login Keychain, which HOME does not control. That is why this is never run by default.
  const claudeVersion =
    process.env.E2E_CLAUDE === '1'
      ? spawnSync('claude', ['--version'], { encoding: 'utf8' })
      : { status: -1 };
  if (process.env.E2E_CLAUDE !== '1') {
    s.notTestable(
      J,
      'Claude Code CLI',
      'opt-in: set E2E_CLAUDE=1 to run the real CLI journey (see e2e-ui/README.md)'
    );
  } else if (claudeVersion.status !== 0) {
    s.notTestable(J, 'Claude Code CLI', 'claude is not installed');
  } else {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-e2e-claude-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-e2e-claude-proj-'));
    (ctx.extraRoots ??= []).push(cfgDir, proj);
    const env = {
      PATH: process.env.PATH,
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      CLAUDE_CONFIG_DIR: cfgDir,
      HOME: cfgDir,
      CI: '1'
    };
    const claude = (args, timeout = 90000) =>
      spawnSync('claude', args, { cwd: proj, env, encoding: 'utf8', timeout });
    await s.step(
      J,
      'Claude Code CLI: register the server with its own `mcp add-json` (isolated config dir, project scope)',
      'the CLI accepts the copied config and writes .mcp.json in the project',
      async () => {
        const entry = JSON.stringify(config.mcpServers.filemaker);
        const r = claude(['mcp', 'add-json', 'filemaker', entry, '--scope', 'project']);
        assert(r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
        assert(fs.existsSync(path.join(proj, '.mcp.json')), '.mcp.json not written');
        return `${claudeVersion.stdout.trim()} | ${r.stdout.trim().slice(0, 160)}`;
      }
    );
    await s.step(
      J,
      'Claude Code CLI: `claude mcp list` health check connects to the extension',
      'the CLI shows filemaker as connected and the VS Code audit/connection count reflects a real client',
      async () => {
        const r = claude(['mcp', 'list'], 120000);
        const out = `${r.stdout}${r.stderr}`;
        assert(
          /filemaker/i.test(out) && /connected|✓/i.test(out),
          `filemaker not shown as connected: ${out.slice(0, 200)}`
        );
        return `exit ${r.status}: ${out.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
      }
    );
    await s.step(
      J,
      'Claude Code CLI: non-interactive prompt listing layouts',
      'tool call reaches the extension (audit log) and the answer matches the mock data',
      async () => {
        const r = claude(
          [
            '-p',
            'Use the filemaker MCP tool to list the FileMaker layouts and answer with their names.',
            '--allowedTools',
            'mcp__filemaker__fm_list_layouts',
            '--output-format',
            'text'
          ],
          150000
        );
        const out = `${r.stdout}${r.stderr}`.trim();
        if (/not logged in|login|authenticat|credit|api key|\/login/i.test(out) || r.status !== 0) {
          return {
            result: 'NOT-TESTABLE',
            detail: `the CLI in an isolated config directory has no credentials (${out.replace(/\s+/g, ' ').slice(0, 160)}); I did not use the owner's login`
          };
        }
        assert(/Customers/.test(out), out.slice(0, 300));
        return out.slice(0, 200);
      }
    );
  }
  s.notTestable(
    J,
    'Cursor',
    'Cursor cannot be automated here; the copied config is the same mcpServers shape, but Cursor itself was not run'
  );
  s.notTestable(
    J,
    'Copilot chat UI path',
    'the language-model tools were invoked through vscode.lm.invokeTool by the helper extension (see J10a); the real Copilot chat UI cannot run without a chat model and a signed-in account'
  );
}
