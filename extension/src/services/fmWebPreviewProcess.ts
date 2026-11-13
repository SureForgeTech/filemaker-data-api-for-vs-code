import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import * as vscode from 'vscode';

/** Do not inherit npm configuration, Node injection hooks or public Next env values. */
export function previewProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.NEXT_TELEMETRY_DISABLED = '1';
  return env;
}

export const PREVIEW_INSTALL_DESCRIPTION = 'npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --workspaces=false --include=optional';
export const PREVIEW_DEV_DESCRIPTION = 'npm run dev --ignore-scripts -- --hostname 127.0.0.1 --port 3000';

/** Each launch gets a fresh owner-only directory. No repository npm config, lock or dependency tree is executed. */
export class FmWebPreviewProcess implements vscode.Disposable {
  private child?: ChildProcess;
  private directory?: string;
  private cancelled = false;

  public async start(files: Map<string, Buffer>, layouts: Map<string, Buffer>, bridgeUrl: string, token: string): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'fmweb-preview-'));
    this.directory = directory;
    await chmod(directory, 0o700);
    const root = path.join(directory, 'runtime-next');
    await mkdir(root, { mode: 0o700 });
    for (const [name, bytes] of files) {
      const target = path.resolve(root, name);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid template path.');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    }
    await mkdir(path.join(directory, 'layouts'));
    for (const [name, bytes] of layouts) {
      if (path.basename(name) !== name || !name.endsWith('.layout.json')) throw new Error('Invalid layout path.');
      await writeFile(path.join(directory, 'layouts', name), bytes, { flag: 'wx', mode: 0o600 });
    }
    const userconfig = path.join(directory, 'user.npmrc');
    const globalconfig = path.join(directory, 'global.npmrc');
    await writeFile(userconfig, '', { mode: 0o600, flag: 'wx' });
    await writeFile(globalconfig, '', { mode: 0o600, flag: 'wx' });
    const flags = [`--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`, `--prefix=${root}`, `--cache=${path.join(directory, 'cache')}`];
    const env = previewProcessEnv(process.env);
    // A shell is never involved. On Windows use node to execute npm's JS entrypoint rather than npm.cmd.
    const npm = process.platform === 'win32' ? 'node' : 'npm';
    const prefix = process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : [];
    await this.install(npm, [...prefix, ...flags, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--workspaces=false', '--include=optional'], root, env);
    if (this.cancelled) throw new Error('Preview was cancelled.');
    const launch = randomBytes(32).toString('hex');
    const session = randomBytes(32).toString('hex');
    const child = spawn(npm, [...prefix, ...flags, 'run', 'dev', '--ignore-scripts', '--', '--hostname', '127.0.0.1', '--port', '3000'], {
      cwd: root, shell: false, detached: process.platform !== 'win32',
      env: { ...env, FMWEB_BRIDGE_URL: bridgeUrl, FMWEB_BRIDGE_TOKEN: token,
        FMWEB_LAUNCH_CODE: launch, FMWEB_PREVIEW_SESSION: session,
        FMWEB_LAUNCH_EXPIRES: String(Date.now() + 120_000), FMWEB_LAUNCH_STATE: path.join(directory, 'launch-used') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    // Never echo server output: request logs could contain the one-time launch credential.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview did not become ready in time.')), 90_000);
      let output = '';
      const ready = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        if (/Ready in|✓ Ready/.test(output)) { clearTimeout(timer); resolve(); }
      };
      child.stdout?.on('data', ready);
      child.stderr?.on('data', ready);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start npm. Check that Node.js and npm are installed.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Preview stopped before it was ready. Port 3000 must be free.')); });
    });
    if (this.cancelled) throw new Error('Preview was cancelled.');
    await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:3000/?launch=${launch}`));
  }

  private install(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: 'ignore' });
      this.child = child;
      child.once('error', () => reject(new Error('Could not run npm install. Check that Node.js and npm are installed.')));
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Preview dependency installation failed. No install scripts were run.')));
    });
  }

  public dispose(): void {
    this.cancelled = true;
    if (this.child?.pid) {
      try {
        if (process.platform === 'win32') this.child.kill();
        else process.kill(-this.child.pid, 'SIGTERM');
      } catch { /* Already stopped. */ }
    }
    // Delete only this process's private mkdtemp directory.
    if (this.directory) void rm(this.directory, { recursive: true, force: true });
  }
}
