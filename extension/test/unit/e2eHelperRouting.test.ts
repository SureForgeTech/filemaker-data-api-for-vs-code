import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error The UI harness is JavaScript; no browser dependencies are loaded here.
import { Session } from '../../e2e-ui/lib/session.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function helperHost(dir: string, workspacePath: string) {
  let poll!: () => Promise<void>;
  const invokeTool = vi.fn().mockResolvedValue({ content: [] });
  const module = { exports: {} as { activate(context: { subscriptions: unknown[] }): void } };
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: workspacePath } }] },
    lm: { invokeTool }
  };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../../e2e-ui/helper-extension/extension.js'), 'utf8'), {
    module, process: { env: { FM_E2E_HELPER_DIR: dir } },
    require: (name: string) => ({ vscode, fs, path })[name as 'vscode' | 'fs' | 'path'],
    setInterval: (fn: typeof poll) => { poll = fn; }, clearInterval: vi.fn()
  });
  module.exports.activate({ subscriptions: [] });
  return { poll, invokeTool };
}

it('does not replay another window\'s tool calls or completed requests after a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-helper-routing-'));
  roots.push(dir);
  const main = helperHost(dir, '/workspace/main');
  const request = (id: string, workspacePath: string) => fs.writeFileSync(
    path.join(dir, 'requests', `${id}.json`),
    JSON.stringify({ action: 'invokeTool', name: 'fm_describe_layout', input: { layout: 'Products' }, workspacePath })
  );
  request('old', '/workspace/main');
  await main.poll();
  expect(main.invokeTool).toHaveBeenCalledOnce();
  const second = helperHost(dir, '/workspace/second');
  request('pending-main', '/workspace/main');
  request('second', '/workspace/second');
  await second.poll();
  expect(second.invokeTool).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(dir, 'responses', 'pending-main.json'))).toBe(false);
  await main.poll();
  expect(main.invokeTool).toHaveBeenCalledTimes(2);
  const reloaded = helperHost(dir, '/workspace/main');
  await reloaded.poll();
  expect(reloaded.invokeTool).not.toHaveBeenCalled();
});

it('addresses a helper request to the session workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-helper-envelope-'));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, 'responses'));
  fs.writeFileSync(path.join(dir, 'responses', 'r123-1.json'), '{"ok":true,"data":{"ok":true}}');
  const now = vi.spyOn(Date, 'now').mockReturnValue(123);
  try {
    await Session.prototype.helper.call({ helperIO: dir, ws: '/workspace/main', reqN: 0 }, 'ping');
    const req = JSON.parse(fs.readFileSync(path.join(dir, 'requests', 'r123-1.json'), 'utf8'));
    expect(req).toEqual({ action: 'ping', workspacePath: '/workspace/main' });
  } finally { now.mockRestore(); }
});
