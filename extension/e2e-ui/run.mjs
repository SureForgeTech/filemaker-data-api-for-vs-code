#!/usr/bin/env node
// Real VS Code UI end-to-end tests. Run with `npm run test:e2e-ui` from extension/.
//   E2E_ONLY=j02,j03      run only these journeys (prefix match on the journey file name)
//   E2E_KEEP=1            keep the temp profile and leave VS Code logs in the artifacts folder
//   E2E_ARTIFACTS=dir     where screenshots and the report go (default: <repo>/artifacts/e2e-ui/<timestamp>)
//   E2E_VSCODE_VERSION    VS Code version for @vscode/test-electron (default: stable)
//   E2E_VSCODE_CACHE      download cache (default: <tmp>/fm-e2e-vscode-cache)
//   E2E_VSIX              VSIX to test (default: ../artifacts/filemaker-data-api-tools-<version>.vsix)
//   E2E_CLAUDE=1          also run the real Claude Code CLI steps in J10b (off by default, see README)
//   E2E_UPDATE_KNOWN=1    rewrite known-findings.json from this run (the findings the suite tolerates)
//   E2E_STRICT=1          every failing step fails the run, ignoring known-findings.json
// Exit code: 0 when every FAIL is listed in e2e-ui/known-findings.json (a known finding); 1 when a step
// fails that is not listed (a regression or a new finding), when a journey crashes, or with E2E_STRICT=1.
// Missing prerequisites skip locally, but fail when E2E_STRICT=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMock } from './lib/mock.mjs';
import { Report } from './lib/report.mjs';
import { getVSCode, loadDeps, Session } from './lib/session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const repoRoot = path.resolve(extDir, '..');
const strict = process.env.E2E_STRICT === '1';

function skip(reason) {
  console.log(`E2E UI tests ${strict ? 'cannot run in strict mode' : 'skipped'}: ${reason}`);
  process.exit(strict ? 1 : 0);
}

const deps = loadDeps();
if (deps.error) skip(deps.error);
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
  skip('no display (set DISPLAY, or run under xvfb-run -a npm run test:e2e-ui)');
const version = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version;
const vsix =
  process.env.E2E_VSIX ??
  path.join(repoRoot, 'artifacts', `filemaker-data-api-tools-${version}.vsix`);
if (!fs.existsSync(vsix))
  skip(
    `no VSIX at ${vsix}. Build it first: npm run build -w shared && npm run package:check (from the repo root / extension/)`
  );

// Leftovers of a run that was killed hard (SIGKILL cannot be caught): remove old temp roots of ours.
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!/^fm-(e2e|mock-tls)-/.test(name) || name === 'fm-e2e-vscode-cache') continue;
  const dir = path.join(os.tmpdir(), name);
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs > 6 * 3600 * 1000)
      fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* not ours or already gone */
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = process.env.E2E_ARTIFACTS ?? path.join(repoRoot, 'artifacts', 'e2e-ui', stamp);
fs.mkdirSync(artifacts, { recursive: true });
const report = new Report(artifacts);
const t0 = Date.now();

const only = (process.env.E2E_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const journeyFiles = fs
  .readdirSync(path.join(here, 'journeys'))
  .filter((f) => /^j\d+.*\.mjs$/.test(f))
  .sort();
const selected = journeyFiles.filter((f) => !only.length || only.some((o) => f.startsWith(o)));
if (!selected.length) skip('no journeys matched E2E_ONLY');

let vscode;
try {
  vscode = await getVSCode();
} catch (e) {
  skip(`could not obtain VS Code (${e.message})`);
}

const mock = await startMock();
const s = new Session({ report, vscode, name: 'main' });
const ctx = {
  s,
  mock,
  report,
  vsix,
  artifacts,
  extDir,
  repoRoot,
  vscode,
  helperDir: path.join(here, 'helper-extension'),
  version
};
let exitCode = 0;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  try {
    await s.dispose({ keepLogsTo: path.join(artifacts, 'vscode-logs') });
  } catch {
    /* best effort */
  }
  try {
    await mock.stop();
  } catch {
    /* best effort */
  }
  for (const fn of ctx.cleanups ?? []) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
  for (const dir of ctx.extraRoots ?? []) fs.rmSync(dir, { recursive: true, force: true });
};
for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129]
])
  process.on(sig, async () => {
    await cleanup();
    process.exit(code);
  });
for (const ev of ['uncaughtException', 'unhandledRejection'])
  process.on(ev, async (e) => {
    console.error(`${ev}: ${e?.stack ?? e}`);
    await cleanup();
    process.exit(1);
  });
try {
  s.installVsix(vsix);
  console.log(
    `VS Code (${vscode.integrity}) ${path.basename(path.dirname(path.dirname(path.dirname(path.dirname(vscode.exe)))))} | mock ${mock.baseUrl} | artifacts ${artifacts}`
  );
  for (const file of selected) {
    const mod = await import(path.join(here, 'journeys', file));
    console.log(`\n=== ${file} ===`);
    if (s.app) for (const w of s.app.windows()) if (w !== s.page) await w.close().catch(() => {}); // a stray second window steals key events
    try {
      if (!s.app && !mod.ownsLaunch) await s.launch();
      else if (s.app && !s.helperOn && !mod.ownsLaunch) await s.restart();
      s.trustThrow = false;
      await mod.run(ctx);
    } catch (e) {
      exitCode = 1;
      report.add({
        journey: file,
        step: 'journey crashed',
        expect: 'journey completes',
        result: 'FAIL',
        shot: await s.shot('crash', file),
        detail: e.stack ?? String(e)
      });
    }
    report.write();
  }
} finally {
  report.write();
  await cleanup();
}
const failedRows = report.rows.filter((r) => r.result === 'FAIL');
const knownFile = path.join(here, 'known-findings.json');
const knownKey = (r) => `${r.journey} | ${r.step}`;
const ran = new Set(report.rows.map((r) => String(r.journey).split(' ')[0]));
if (process.env.E2E_UPDATE_KNOWN === '1') {
  // Keep the entries of journeys that were not run this time; replace the ones that were.
  const old = fs.existsSync(knownFile)
    ? JSON.parse(fs.readFileSync(knownFile, 'utf8')).findings
    : [];
  const kept = old.filter((k) => !ran.has(k.split(' ')[0]));
  const now = failedRows.map(knownKey);
  const findings = [...new Set([...kept, ...now])].sort();
  fs.writeFileSync(
    knownFile,
    `${JSON.stringify(
      {
        note: 'Steps that fail today because of a known product finding (see the PR report). A step listed here may fail without failing the run; a step NOT listed fails the run. Regenerate with E2E_UPDATE_KNOWN=1 npm run test:e2e-ui after triaging every new failure.',
        findings
      },
      null,
      2
    )}\n`
  );
  console.log(`known-findings.json updated: ${findings.length} entries`);
}
const known = new Set(
  fs.existsSync(knownFile) ? JSON.parse(fs.readFileSync(knownFile, 'utf8')).findings : []
);
const newFailures = failedRows.filter((r) => strict || !known.has(knownKey(r)));
const unasserted = report.rows.filter((r) => r.unasserted);
const fixed = [...known].filter(
  (k) =>
    ran.has(k.split(' ')[0]) &&
    report.rows.some((r) => knownKey(r) === k) &&
    !failedRows.some((r) => knownKey(r) === k)
);
console.log(
  `\nDone in ${Math.round((Date.now() - t0) / 1000)}s: ${report.rows.length} steps, ${failedRows.length} failed (${failedRows.length - newFailures.length} known findings, ${newFailures.length} new). Report: ${path.join(artifacts, 'report.md')}`
);
if (fixed.length)
  console.log(
    `Known findings that now pass (remove them from known-findings.json): ${fixed.length}`
  );
if (unasserted.length)
  console.log(
    `Steps without an assertion (reported as NOTE): ${unasserted.length}\n  ${unasserted.map((r) => knownKey(r)).join('\n  ')}`
  );
for (const r of newFailures)
  console.log(`NEW FAILURE: ${knownKey(r)} -- ${String(r.detail).split('\n')[0].slice(0, 200)}`);
process.exit(exitCode || (newFailures.length ? 1 : 0));
