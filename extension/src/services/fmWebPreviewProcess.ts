import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import * as vscode from 'vscode';

/** Do not inherit npm configuration, Node injection hooks or public Next env values. */
export function previewProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.NEXT_TELEMETRY_DISABLED = '1';
  return env;
}

export const PREVIEW_INSTALL_DESCRIPTION = 'npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --workspaces=false --include=optional';
export const PREVIEW_DEV_DESCRIPTION = 'npm run dev --ignore-scripts -- --hostname 127.0.0.1 --port 3000';

const OWNER_FILE = '.fmweb-preview-owner';
const OWNER_MARKER = 'filemaker-data-api-for-vs-code preview v1\n';
const activePreviews = new Set<FmWebPreviewProcess>();

export async function stopFmWebPreviews(): Promise<void> {
  await Promise.all([...activePreviews].map((preview) => preview.dispose()));
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out stopping the private preview.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

interface PreviewProcessOptions {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  kill: typeof process.kill;
  tempRoot: string;
  sourceEnv: NodeJS.ProcessEnv;
}

/** Each launch gets a fresh owner-only directory. No repository npm config, lock or dependency tree is executed. */
export class FmWebPreviewProcess implements vscode.Disposable {
  private child?: ChildProcess;
  private directory?: string;
  private cancelled = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly options: PreviewProcessOptions;

  public constructor(options: Partial<PreviewProcessOptions> = {}) {
    this.options = { platform: process.platform, spawn, kill: process.kill, tempRoot: tmpdir(), sourceEnv: process.env, ...options };
  }

  public start(files: Map<string, Buffer>, layouts: Map<string, Buffer>, bridgeUrl: string, token: string): Promise<void> {
    activePreviews.add(this);
    this.starting = this.launch(files, layouts, bridgeUrl, token);
    return this.starting;
  }

  /** Only remove old directories carrying our exact ownership marker; never follow links. */
  private async removeStaleDirectories(): Promise<void> {
    for (const name of await readdir(this.options.tempRoot)) {
      if (!name.startsWith('fmweb-preview-')) continue;
      const directory = path.join(this.options.tempRoot, name);
      if ([...activePreviews].some((preview) => preview.directory === directory)) continue;
      try {
        if (!(await lstat(directory)).isDirectory()) continue;
        const marker = path.join(directory, OWNER_FILE);
        const info = await lstat(marker);
        if (!info.isFile() || info.mtimeMs >= Date.now() - 86_400_000) continue;
        if (await readFile(marker, 'utf8') !== OWNER_MARKER) continue;
        await bounded(rm(directory, { recursive: true, force: true }), 5000);
      } catch { /* Leave unrecognised or inaccessible directories alone. */ }
    }
  }

  private async npmCommand(env: NodeJS.ProcessEnv): Promise<{ command: string; prefix: string[] }> {
    if (this.options.platform !== 'win32') return { command: 'npm', prefix: [] };
    // Electron's executable directory does not contain npm. Resolve both tools from PATH,
    // then execute npm's JS entrypoint directly, without a command shell.
    const directories = (env.PATH ?? env.Path ?? '').split(';').filter((dir) => path.isAbsolute(dir));
    const find = async (suffix: string): Promise<string | undefined> => {
      for (const dir of directories) {
        const file = path.join(dir, suffix);
        if ((await stat(file).catch(() => undefined))?.isFile()) return file;
      }
      return undefined;
    };
    const node = await find('node.exe');
    const cli = await find(path.join('node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (!node || !cli) throw new Error('Could not find Node.js and npm on PATH. Install Node.js with npm to start the preview.');
    return { command: node, prefix: [cli] };
  }

  private async launch(files: Map<string, Buffer>, layouts: Map<string, Buffer>, bridgeUrl: string, token: string): Promise<void> {
    await this.removeStaleDirectories();
    const directory = await mkdtemp(path.join(this.options.tempRoot, 'fmweb-preview-'));
    this.directory = directory;
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, OWNER_FILE), OWNER_MARKER, { mode: 0o600, flag: 'wx' });
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
    const env = previewProcessEnv(this.options.sourceEnv);
    const { command: npm, prefix } = await this.npmCommand(env);
    if (this.cancelled) throw new Error('Preview was cancelled.');
    await this.install(npm, [...prefix, ...flags, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--workspaces=false', '--include=optional'], root, env);
    if (this.cancelled) throw new Error('Preview was cancelled.');
    const launch = randomBytes(32).toString('hex');
    const session = randomBytes(32).toString('hex');
    const child = this.options.spawn(npm, [...prefix, ...flags, 'run', 'dev', '--ignore-scripts', '--', '--hostname', '127.0.0.1', '--port', '3000'], {
      cwd: root, shell: false, detached: this.options.platform !== 'win32',
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
      const child = this.options.spawn(command, args, { cwd, env, shell: false, detached: this.options.platform !== 'win32', stdio: 'ignore' });
      this.child = child;
      child.once('error', () => reject(new Error('Could not run npm install. Check that Node.js and npm are installed.')));
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Preview dependency installation failed. No install scripts were run.')));
    });
  }

  public dispose(): Promise<void> {
    this.cancelled = true;
    this.stopping ??= this.stop().catch((error) => {
      this.stopping = undefined;
      throw error;
    });
    return this.stopping;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (child?.pid) {
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve() : new Promise<void>((resolve) => child.once('exit', () => resolve()));
      if (this.options.platform === 'win32') {
        // taskkill waits for the wrapper AND its descendants, including next dev.
        const killer = this.options.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        await bounded(new Promise<void>((resolve, reject) => {
          killer.once('error', reject);
          killer.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Could not stop the preview process tree.')));
        }), 5000);
        await bounded(exited, 2000);
      } else {
        try { this.options.kill(-child.pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        try { await bounded(exited, 2000); } catch { /* Escalate below. */ }
        // The npm wrapper can exit before its descendants; kill the remaining group too.
        try { this.options.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await bounded(exited, 2000);
      }
    }
    this.child = undefined;
    // Cancellation during setup must finish before deletion, and must never start npm.
    await bounded(this.starting?.catch(() => undefined) ?? Promise.resolve(), 5000);
    if (this.directory) await bounded(rm(this.directory, { recursive: true, force: true }), 5000);
    activePreviews.delete(this);
  }
}
