import { EventEmitter } from 'events';
import { lstat, readFile, readdir } from 'fs/promises';
import path from 'path';
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean }; child: EventEmitter }>);
vi.mock('child_process', () => ({ spawn: vi.fn((command, args, options) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  calls.push({ command, args, options, child });
  queueMicrotask(() => args.includes('install') ? child.emit('exit', 0) : child.stdout.emit('data', Buffer.from('✓ Ready in 100ms')));
  return child;
}) }));

import { FmWebPreviewProcess, previewProcessEnv } from '../../src/services/fmWebPreviewProcess';

beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });
describe('A5/A8 private process launch', () => {
  it('excludes npm, Node and Next overrides while preserving OS executable lookup', () => {
    const result = previewProcessEnv({ PATH: '/trusted/bin', HOME: '/home/user', npm_config_script_shell: './evil', NPM_CONFIG_REGISTRY: 'https://evil', NODE_OPTIONS: '--require=evil', NODE_PATH: './evil', NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN: 'evil' });
    expect(result).toEqual({ PATH: '/trusted/bin', HOME: '/home/user', NEXT_TELEMETRY_DISABLED: '1' });
  });
  it('uses fresh private files, pinned empty configs, no install scripts, and credentials only in the server env', async () => {
    const process = new FmWebPreviewProcess();
    try {
      await process.start(new Map([['package.json', Buffer.from('{}')]]), new Map(), 'http://127.0.0.1:1234/fm', 'dummy-secret');
      expect(calls).toHaveLength(2);
      const install = calls[0]!;
      const dev = calls[1]!;
      expect(install.options.shell).toBe(false);
      expect(install.args).toEqual(expect.arrayContaining(['install', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--workspaces=false']));
      expect(dev.args).toEqual(expect.arrayContaining(['run', 'dev', '--ignore-scripts', '--hostname', '127.0.0.1', '--port', '3000']));
      for (const call of calls) {
        for (const config of ['--userconfig=', '--globalconfig=']) {
          const file = call.args.find((arg) => arg.startsWith(config))!.slice(config.length);
          expect(await readFile(file, 'utf8')).toBe('');
        }
        expect(call.args.join(' ')).not.toContain('dummy-secret');
        expect(call.options.env).not.toHaveProperty('NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN');
      }
      expect(install.options.env).not.toHaveProperty('FMWEB_BRIDGE_TOKEN');
      expect(dev.options.env.FMWEB_BRIDGE_TOKEN).toBe('dummy-secret');
      expect(dev.options.env.FMWEB_LAUNCH_CODE).toHaveLength(64);
      expect(dev.options.env.FMWEB_PREVIEW_SESSION).toHaveLength(64);
      expect(dev.options.env.FMWEB_LAUNCH_CODE).not.toBe(dev.options.env.FMWEB_PREVIEW_SESSION);
      const parent = path.dirname(install.options.cwd);
      if (globalThis.process.platform !== 'win32') expect((await lstat(parent)).mode & 0o777).toBe(0o700);
      expect(await readdir(install.options.cwd)).toEqual(['package.json']);
      expect(vi.mocked(vscode.env.openExternal).mock.calls[0]?.[0].toString()).toBe(`http://127.0.0.1:3000/?launch=${dev.options.env.FMWEB_LAUNCH_CODE}`);
    } finally { process.dispose(); }
  });
});
