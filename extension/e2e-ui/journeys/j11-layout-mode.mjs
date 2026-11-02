// Journey 11: FM Web project, Layout Mode and the preview server: open, confirmations (declined), what works at this commit.
import fs from 'node:fs';
import path from 'node:path';

import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J11 layout mode';
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory()
            ? e.name === 'node_modules'
              ? []
              : walk(path.join(dir, e.name))
            : [path.join(dir, e.name)]
        )
    : [];

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');

  await s.step(
    J,
    'Initialize FM Web Project',
    'toast; .fmweb folder with a project file appears in the workspace',
    async () => {
      await s.cmd('FileMaker: Initialize FM Web Project');
      const t = await s.waitToast(/Initialized FM Web project|FM Web/i, { timeout: 20000 });
      const files = walk(path.join(s.ws, '.fmweb')).map((f) => path.relative(s.ws, f));
      assert(files.length > 0, 'no .fmweb files');
      return `${t} | ${files.slice(0, 6).join(', ')}`;
    }
  );
  await s.step(
    J,
    'after Initialize, the other FM Web commands are offered',
    'Sync and Open Layout Mode appear without reloading; Generate and Start Preview stay hidden in the Marketplace build',
    async () => {
      const ms = await s.waitCmdListed('FileMaker: Open FM Web Layout Mode', 10000);
      if (ms < 0) {
        await s.reloadWindow();
        const after = await s.waitCmdListed('FileMaker: Open FM Web Layout Mode', 8000);
        throw new Error(
          `not offered within 10 s of initialising the project; ${after >= 0 ? 'they appear only after a window reload' : 'not offered even after a reload'} (context key filemaker.fmWebProjectInitialized is refreshed only by Refresh Connections)`
        );
      }
      const sync = await s.cmdListed('FileMaker: Sync FM Web Project Metadata');
      const generate = await s.cmdListed('FileMaker: Generate FM Web Next.js App');
      const preview = await s.cmdListed('FileMaker: Start FM Web Preview Server');
      assert(sync, 'Sync FM Web Project Metadata is not offered after Initialize');
      assert(
        !generate && !preview,
        `Marketplace preview commands should stay hidden (Generate=${generate}, Start Preview=${preview})`
      );
      return `Layout Mode listed after ${ms} ms; Sync listed; Generate and Start Preview hidden`;
    }
  );
  await s.step(
    J,
    'Sync FM Web Project Metadata',
    'metadata for the active profile is written under .fmweb',
    async () => {
      await s.cmd('FileMaker: Sync FM Web Project Metadata');
      await answerPickers(s, ['Mock Quality']);
      await s.page.waitForTimeout(5000);
      const toasts = await s.toasts();
      const files = walk(path.join(s.ws, '.fmweb')).map((f) => path.relative(s.ws, f));
      return `toasts: ${toasts.join(' || ') || 'none'} | files: ${files.length}`;
    }
  );
  await s.step(
    J,
    'Open FM Web Layout Mode',
    'a designer panel opens (webview) for a layout',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Open FM Web Layout Mode');
      await answerPickers(s, ['Mock Quality', 'Customers'], { max: 3 });
      await s.page.waitForTimeout(5000);
      const tabs = await s.editorTabs();
      const frame = s.page.frames().find((f) => /fake\.html/.test(f.url()));
      const body = frame
        ? (
            await frame
              .locator('body')
              .innerText()
              .catch(() => '')
          )
            .replace(/\s+/g, ' ')
            .slice(0, 300)
        : '';
      const toasts = await s.toasts();
      assert(
        tabs.some((t) => /Layout/i.test(t)),
        `tabs: ${tabs.join(', ')}; toasts: ${toasts.join(' | ')}`
      );
      return `tabs: ${tabs.join(', ')} | panel text: ${body || '(empty)'}`;
    }
  );
  await s.step(
    J,
    'Generate FM Web Next.js App from the Marketplace build',
    'the command is hidden because the preview runtime is not shipped; nothing is generated',
    async () => {
      await s.closeAllEditors();
      const listed = await s.cmdListed('FileMaker: Generate FM Web Next.js App');
      const files = walk(path.join(s.ws, '.fmweb', 'generated')).map((f) => path.relative(s.ws, f));
      assert(!listed, 'Generate FM Web Next.js App is offered without the preview runtime');
      assert(files.length === 0, `unexpected generated files: ${files.join(', ')}`);
      return 'command hidden; 0 generated files';
    }
  );
  await s.step(
    J,
    'Start FM Web Preview Server from the Marketplace build',
    'the command is hidden because the preview runtime is not shipped; no install or server starts',
    async () => {
      const listed = await s.cmdListed('FileMaker: Start FM Web Preview Server');
      const terminals = await s.page.locator('.terminal-tab, .terminal-tabs-entry').count();
      const nm = fs.existsSync(
        path.join(s.ws, '.fmweb', 'generated', 'runtime-next', 'node_modules')
      );
      assert(!listed, 'Start FM Web Preview Server is offered without the preview runtime');
      assert(
        !nm && terminals === 0,
        `a terminal or node_modules appeared (terminals ${terminals}, node_modules ${nm})`
      );
      return `command hidden; terminals ${terminals}; node_modules ${nm}`;
    }
  );
  s.notTestable(
    J,
    'script-run confirmation from a layout file',
    'needs a layout definition with a script behaviour wired in the designer; the guard is covered by test/unit/layoutModeScriptGuard.test.ts, not driven through the UI here'
  );
  s.notTestable(
    J,
    'preview server actually started',
    'the Marketplace VSIX intentionally does not include the preview runtime; this journey verifies that its commands stay hidden'
  );
  await s.closeAllEditors();
}
