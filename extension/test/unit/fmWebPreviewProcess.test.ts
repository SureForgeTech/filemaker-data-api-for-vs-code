import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type * as FsPromises from 'fs/promises';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

import { FmWebRuntimeGenerator } from '../../src/services/fmWebRuntimeGenerator';
import { FmWebPreviewProcess, previewProcessEnv, stopFmWebPreviews } from '../../src/services/fmWebPreviewProcess';

type MockChild = ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
const calls: Array<{ command: string; args: string[]; options: Record<string, unknown>; child: MockChild }> = [];
let directory: string;
let signalExit: boolean;
let actualRm: typeof rm;
const kill = vi.fn((pid: number) => {
  const child = calls.find((call) => call.child.pid === -pid)?.child;
  if (signalExit && child) exit(child);
  return true as const;
});
function exit(child: MockChild) {
  Object.assign(child, { exitCode: 0 });
  child.emit('exit', 0);
}
function preview(platform: NodeJS.Platform = 'linux', sourceEnv: NodeJS.ProcessEnv = {}) {
  return new FmWebPreviewProcess({ platform, spawn, kill, tempRoot: directory, sourceEnv });
}
const start = (preview: FmWebPreviewProcess) => preview.start(new Map([['package.json', Buffer.from('{}')]]), new Map(), 'http://127.0.0.1:1234/fm', 'dummy-secret');

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'fmweb-process-test-'));
  actualRm = (await vi.importActual<typeof FsPromises>('fs/promises')).rm;
  calls.length = 0;
  vi.clearAllMocks();
  vi.mocked(rm).mockImplementation(actualRm);
  signalExit = true;
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: Record<string, unknown>) => {
    const child = Object.assign(new EventEmitter(), { pid: 100 + calls.length, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() }) as MockChild;
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      if (command === 'taskkill') {
        const target = calls.find((call) => call.child.pid === Number(args[1]))?.child;
        if (target) exit(target);
        exit(child);
      } else if (args.includes('install')) exit(child);
      else child.stdout.emit('data', Buffer.from('✓ Ready in 100ms'));
    });
    return child;
  }) as typeof spawn);
});
afterEach(async () => {
  signalExit = true;
  vi.useRealTimers();
  await stopFmWebPreviews();
  await actualRm(directory, { recursive: true, force: true });
});

describe('private preview process', () => {
  it('excludes npm, Node and Next overrides while preserving only the declared OS and network settings', () => {
    const network = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'].map((key) => [key, `test-${key}`]));
    const result = previewProcessEnv({ ...network, PATH: '/trusted/bin', HOME: '/home/user', npm_config_script_shell: './evil', NPM_CONFIG_REGISTRY: 'https://evil', NODE_OPTIONS: '--require=evil', NODE_PATH: './evil', NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN: 'evil', FMWEB_BRIDGE_TOKEN: 'evil', SECRET: 'evil', ALL_PROXY: 'evil' });
    expect(result).toEqual({ ...network, PATH: '/trusted/bin', HOME: '/home/user', NEXT_TELEMETRY_DISABLED: '1' });
  });

  it('uses private files, empty configs, no install scripts, and credentials only in the server env', async () => {
    const process = preview();
    await start(process);
    expect(calls).toHaveLength(2);
    const install = calls[0]!;
    const dev = calls[1]!;
    expect(install.command).toBe('npm');
    expect(dev.command).toBe('npm');
    expect(install.args).toEqual(expect.arrayContaining(['install', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--workspaces=false']));
    expect(dev.args).toEqual(expect.arrayContaining(['run', 'dev', '--ignore-scripts', '--hostname', '127.0.0.1', '--port', '3000']));
    for (const call of calls) {
      expect(call.options.shell).toBe(false);
      expect(call.options.detached).toBe(true);
      for (const config of ['--userconfig=', '--globalconfig=']) {
        const file = call.args.find((arg) => arg.startsWith(config))!.slice(config.length);
        expect(await readFile(file, 'utf8')).toBe('');
      }
      expect(call.args.join(' ')).not.toContain('dummy-secret');
      expect(call.options.env).not.toHaveProperty('NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN');
    }
    const installEnv = install.options.env as NodeJS.ProcessEnv;
    const devEnv = dev.options.env as NodeJS.ProcessEnv;
    expect(installEnv).not.toHaveProperty('FMWEB_BRIDGE_TOKEN');
    expect(devEnv.FMWEB_BRIDGE_TOKEN).toBe('dummy-secret');
    expect(devEnv.FMWEB_LAUNCH_CODE).toHaveLength(64);
    expect(devEnv.FMWEB_PREVIEW_SESSION).toHaveLength(64);
    expect(devEnv.FMWEB_LAUNCH_CODE).not.toBe(devEnv.FMWEB_PREVIEW_SESSION);
    const root = install.options.cwd as string;
    if (globalThis.process.platform !== 'win32') expect((await lstat(path.dirname(root))).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual(['package.json']);
    expect(vi.mocked(vscode.env.openExternal).mock.calls[0]?.[0].toString()).toBe(`http://127.0.0.1:3000/?launch=${devEnv.FMWEB_LAUNCH_CODE}`);
    await process.dispose();
    await expect(lstat(path.dirname(root))).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('starts from a clean temp copy while workspace npm config and user runtime files survive', async () => {
    const workspace = path.join(directory, 'workspace');
    const generated = path.join(workspace, '.fmweb', 'generated');
    await mkdir(generated, { recursive: true });
    const generator = new FmWebRuntimeGenerator({ extensionUri: { fsPath: path.resolve(__dirname, '../..') } } as never, {
      isWorkspaceTrusted: () => true, ensureProjectInitialized: async () => undefined,
      getGeneratedDirPath: () => generated, getWorkspaceRoot: () => workspace, getProjectRoot: () => path.join(workspace, '.fmweb')
    } as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await generator.generateRuntimeAppTemplate();
    const root = generator.getGeneratedRuntimeRoot();
    await writeFile(path.join(workspace, '.npmrc'), 'registry=https://private.invalid');
    await writeFile(path.join(root, 'app', 'user-page.tsx'), '// keep my page');
    await writeFile(path.join(root, 'next.config.ts'), '// keep my config');
    await writeFile(path.join(root, '.env.local'), 'NEXT_PUBLIC_CUSTOM=keep-me');
    expect(await generator.inspectPreviewFiles()).toEqual(['.env.local', path.join('app', 'user-page.tsx'), 'next.config.ts'].sort());
    const process = preview();
    await process.start(await generator.previewTemplateFiles(), new Map(), 'http://127.0.0.1:1234/fm', 'dummy-secret');
    const privateRoot = calls[0]!.options.cwd as string;
    expect(privateRoot).not.toBe(root);
    expect(await readFile(path.join(privateRoot, 'next.config.ts'), 'utf8')).toContain('transpilePackages');
    await expect(lstat(path.join(privateRoot, 'app', 'user-page.tsx'))).rejects.toHaveProperty('code', 'ENOENT');
    await expect(lstat(path.join(privateRoot, '.env.local'))).rejects.toHaveProperty('code', 'ENOENT');
    await expect(lstat(path.join(privateRoot, '.npmrc'))).rejects.toHaveProperty('code', 'ENOENT');
    expect(await readFile(path.join(workspace, '.npmrc'), 'utf8')).toBe('registry=https://private.invalid');
    expect(await readFile(path.join(root, 'app', 'user-page.tsx'), 'utf8')).toBe('// keep my page');
    expect(await readFile(path.join(root, 'next.config.ts'), 'utf8')).toBe('// keep my config');
    expect(await readFile(path.join(root, '.env.local'), 'utf8')).toBe('NEXT_PUBLIC_CUSTOM=keep-me');
  });

  it('on Windows resolves Node and npm from PATH, with no Electron paths or shell interpolation', async () => {
    const bin = path.join(directory, 'Node with spaces & shell chars');
    const cli = path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, '// mocked npm');
    await writeFile(path.join(bin, 'node.exe'), 'mocked node');
    const process = preview('win32', { PATH: `.;${bin}`, NODE_OPTIONS: '--require=evil' });
    await start(process);
    for (const call of calls) {
      expect(call.command).toBe(path.join(bin, 'node.exe'));
      expect(call.args[0]).toBe(cli);
      expect(call.options).toMatchObject({ shell: false, detached: false });
    }
    const root = path.dirname(calls[0]!.options.cwd as string);
    await process.dispose();
    expect(calls[2]).toMatchObject({ command: 'taskkill', args: ['/PID', String(calls[1]!.child.pid), '/T', '/F'], options: { shell: false } });
    await expect(lstat(root)).rejects.toHaveProperty('code', 'ENOENT');
    expect(kill).not.toHaveBeenCalled();
  });

  it('waits for Windows taskkill to finish the tree even after the npm wrapper exits', async () => {
    const bin = path.join(directory, 'node-bin');
    await mkdir(path.join(bin, 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// npm');
    await writeFile(path.join(bin, 'node.exe'), 'node');
    const process = preview('win32', { PATH: bin });
    await start(process);
    const root = path.dirname(calls[0]!.options.cwd as string);
    const killer = new EventEmitter();
    vi.mocked(spawn).mockReturnValueOnce(killer as ChildProcess);
    const stopped = process.dispose();
    exit(calls[1]!.child);
    await Promise.resolve();
    expect(rm).not.toHaveBeenCalled();
    expect((await lstat(root)).isDirectory()).toBe(true);
    killer.emit('exit', 0);
    await stopped;
    await expect(lstat(root)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('cancelling during install stops its group, waits for exit, and never launches dev', async () => {
    const installer = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as MockChild;
    vi.mocked(spawn).mockImplementationOnce(((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options, child: installer });
      return installer;
    }) as typeof spawn);
    const process = preview();
    const cancelled = expect(start(process)).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await process.dispose();
    await cancelled;
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
    expect(calls).toHaveLength(1);
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it('waits for the POSIX process group to exit before removing files', async () => {
    const process = preview();
    await start(process);
    const root = path.dirname(calls[0]!.options.cwd as string);
    const child = calls[1]!.child;
    signalExit = false;
    const stopped = process.dispose();
    expect(kill).toHaveBeenCalledWith(-child.pid!, 'SIGTERM');
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect(rm).not.toHaveBeenCalled();
    exit(child);
    await stopped;
    expect(kill).toHaveBeenCalledWith(-child.pid!, 'SIGKILL');
    await expect(lstat(root)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('awaits temporary-directory removal during shutdown', async () => {
    const process = preview();
    await start(process);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(rm).mockImplementationOnce(async (...args) => { await gate; await actualRm(...args); });
    let finished = false;
    const shutdown = stopFmWebPreviews().then(() => { finished = true; });
    await vi.waitFor(() => expect(rm).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    release();
    await shutdown;
    expect(finished).toBe(true);
  });

  it('bounds a stuck directory removal', async () => {
    const process = preview();
    await start(process);
    vi.mocked(rm).mockImplementationOnce(() => new Promise(() => undefined));
    vi.useFakeTimers();
    const stopped = expect(process.dispose()).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    vi.useRealTimers();
    await process.dispose();
  });

  it('only reaps old marked preview directories, leaving recent, unowned and linked folders alone', async () => {
    const names = ['fmweb-preview-old', 'fmweb-preview-recent', 'fmweb-preview-unowned', 'unrelated-old'];
    for (const name of names) {
      const folder = path.join(directory, name);
      await mkdir(folder);
      const marker = path.join(folder, '.fmweb-preview-owner');
      await writeFile(marker, name.endsWith('unowned') ? 'someone else' : 'filemaker-data-api-for-vs-code preview v1\n');
      if (!name.endsWith('recent')) await utimes(marker, new Date(0), new Date(0));
    }
    await symlink(path.join(directory, 'unrelated-old'), path.join(directory, 'fmweb-preview-linked'), 'junction');
    const process = preview();
    await start(process);
    expect(await readdir(directory)).not.toContain('fmweb-preview-old');
    for (const name of [...names.slice(1), 'fmweb-preview-linked']) expect(await readdir(directory)).toContain(name);
  });
});
