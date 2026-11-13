import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const readRoot = (file: string) => readFileSync(resolve(__dirname, '../../..', file), 'utf8');
const readExtension = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');

it('keeps the ledger instructions and starts a fresh ledger for the next release', () => {
  const root = readRoot('CHANGELOG.md');
  expect(root).toContain('labels, or\napplies the `changelog-skip` label');
  const unreleased = root.split('\n## Unreleased\n')[1]?.split('\n## ')[0];
  expect(unreleased?.match(/^### \[(?:BREAKING|FEATURE|FIX|INTERNAL|SECURITY)\]$/gm)).toHaveLength(5);
  for (const section of unreleased?.split(/^### /m).slice(1) ?? []) {
    expect(section).toMatch(/^- .+/m);
  }
  expect(root).toContain('\n## 1.7.0 (2026-10-22)\n');
  expect(root).not.toMatch(/^## 1\.6\.0/m);
  const features = root.split('\n## 1.7.0 (2026-10-22)\n')[1]?.split('### [FEATURE]')[1]?.split('### [FIX]')[0];
  expect(features).toContain('Diagnose Connection');
  expect(features).toContain('Test My Server');
});

it('makes 1.7.0 notes available to the release helper and preserves earlier user notes', () => {
  const changelog = readExtension('CHANGELOG.md');
  expect(changelog).toMatch(/^# Changelog\n\n## Unreleased\n[\s\S]*?\n## 1\.7\.0\n/);
  const release = changelog.split('\n## 1.7.0\n')[1]?.split('\n## ')[0];
  expect(release).toContain('_Released 2026-10-22._');
  expect(release).toContain('Upgrading from 1.6.0 to 1.7.0');
  expect(release).toContain('Check for newer changes');
  expect(release).toContain('List records instead');
  expect(release).toContain('FileMaker Cloud');
  expect(changelog.split('\n## 1.6.0\n')[1]?.split('\n## ')[0]).toContain('Layout Mode');
  expect(readExtension('UPGRADE.md')).toContain('## Upgrading from 1.6.0 to 1.7.0');
});

it('agrees on the package version, release instructions and current user guide', () => {
  const manifest = JSON.parse(readExtension('package.json')) as { version: string };
  const lock = JSON.parse(readRoot('package-lock.json')) as { packages: Record<string, { version: string }> };
  expect(manifest.version).toBe('1.9.0');
  expect(lock.packages.extension?.version).toBe(manifest.version);
  const jobAid = readRoot('docs/JOB_AID_MANUAL_RELEASE.md');
  expect(jobAid).toContain("grep -c 'Upgrading from 1.8.0 to 1.9.0' artifacts/RELEASE_NOTES_v1.9.0.md");
  expect(jobAid).toContain("--grep='^\\[minor\\] Release 1\\.9\\.0'");
  expect(readExtension('docs/USER_GUIDE.md')).toContain('### New in 1.9');
});


it('records offline cache ignores and transfer limits once with accurate snapshot behavior', () => {
  for (const [changelog, heading] of [
    [readRoot('CHANGELOG.md'), '## 1.9.0 (2026-11-13)'],
    [readExtension('CHANGELOG.md'), '## 1.9.0']
  ] as const) {
    const release = changelog.split(`\n${heading}\n`)[1]?.split('\n## ')[0] ?? '';
    const ignores = release.split('\n').filter((line) => /offline metadata cache.*ignore their own contents in Git/i.test(line));
    expect(ignores).toHaveLength(1);
    expect(ignores[0]).toMatch(/snapshots (?:are not ignored|remain available to commit)/);
    const deadlines = release.split('\n').filter((line) => /upload.*(?:deadline|ceiling)/i.test(line));
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toMatch(/(?:deadline.*grow.*size|deadline that grows with the size)/);
    expect(deadlines[0]).toMatch(/30 minute(?:s| ceiling)/);
    expect(deadlines[0]).toMatch(/stalled/i);
  }
  // The next release starts empty: no entries in the extension changelog, five empty sections in the ledger.
  const extensionUnreleased = readExtension('CHANGELOG.md').split('\n## Unreleased\n')[1]?.split('\n## ')[0] ?? '';
  expect(extensionUnreleased.trim()).toBe('');
  const unreleased = readRoot('CHANGELOG.md').split('\n## Unreleased\n')[1]?.split('\n## ')[0] ?? '';
  expect(unreleased.match(/^- None\.$/gm)).toHaveLength(5);
  expect(unreleased.match(/^- (?!None\.).+/gm)).toBeNull();
});

const releaseDocs = (files: string[]) => files.map((file) => readRoot(file));
const upgrade = 'extension/UPGRADE.md';
const troubleshooting = 'extension/docs/TROUBLESHOOTING.md';
const faq = 'extension/docs/FAQ.md';
const guide = 'extension/docs/USER_GUIDE.md';
const security = 'docs/security.md';
const handling = 'docs/DATA_HANDLING.md';
const failures = 'docs/FILEMAKER_FAILURE_MODES.md';
const changelogs = ['CHANGELOG.md', 'extension/CHANGELOG.md'];

it('documents the non-blocking HTTP warning and loopback exemption', () => {
  expect(readRoot(upgrade)).toContain('### Plain HTTP now shows a warning');
  for (const doc of releaseDocs([upgrade, troubleshooting])) {
    expect(doc).toMatch(/no buttons.*connecting continues/);
    expect(doc).toContain('Loopback addresses are exempt');
    expect(doc).not.toMatch(/asks before connecting|continuing sends/);
  }
});

it('locates oversize response text in Details rather than the notice', () => {
  for (const doc of releaseDocs([upgrade, troubleshooting, faq, security, failures, guide])) {
    expect(doc).toMatch(/notice names the failed action/);
    expect(doc).toMatch(/\*\*Details\*\*, under \*\*Stack trace \(redacted\)\*\*/);
    expect(doc).toContain('no HTTP status');
  }
});

it('explains regeneration of the preview after rollback', () => {
  const doc = readRoot(upgrade).split('### Rolling back')[1]?.split('\n## ')[0];
  expect(doc).toContain('delete `.fmweb/generated/runtime-next` and generate it again with 1.8.0');
  expect(doc).toContain('same key');
  expect(doc).toContain('`hashAlgorithm` field and a `.gitignore`');
});

it('documents timeout seconds as optional and omitted for uploads', () => {
  for (const doc of releaseDocs([upgrade, troubleshooting, faq, guide, security, failures])) {
    expect(doc).toContain('request timed out (after N s)');
    expect(doc).toMatch(/[Uu]ploads omit the seconds/);
  }
});

it('limits progress renewal to record reads and caps the base timeout setting', () => {
  for (const doc of releaseDocs([upgrade, troubleshooting, faq, guide, security, failures, ...changelogs])) {
    expect(doc).toMatch(/record GET and find reads.*64 KiB/);
    expect(doc).toContain('120000 ms (2 minutes)');
    expect(doc).not.toMatch(/small requests.*fixed|Small (?:Data API )?requests/);
  }
});

it('distinguishes ignored cache contents from the committable ignore file', () => {
  for (const doc of releaseDocs([upgrade, guide, faq, security, handling, ...changelogs])) {
    expect(doc).toMatch(/ignore (?:their|its) own contents in Git/);
    expect(doc).toMatch(/\.gitignore` (?:file )?(?:itself )?(?:stays visible and can be committed|remains available to commit)/);
    expect(doc).not.toMatch(/ignore themselves|ignores itself|self-ignoring/);
  }
});

it('explains username-only cleanup, direct-auth password migration and retained-entry warnings', () => {
  for (const doc of releaseDocs([upgrade, security, handling])) {
    expect(doc).toContain('user name with no password is also removed');
    expect(doc).toContain('only for direct-auth profiles');
    expect(doc).toContain('proxy-mode entry with a URL password is left as it was');
    expect(doc).toContain('even if the stored value is kept');
  }
});

it('describes session closure on profile removal as an attempt', () => {
  for (const doc of releaseDocs([upgrade, guide, security, handling, failures, ...changelogs])) {
    expect(doc).toMatch(/attempts to close\s+(?:its|the) server session/);
    expect(doc).not.toMatch(/(?:[Rr]emoving a profile|[Pp]rofile deletion|[Dd]eleting a connection profile) closes/);
  }
});

it('documents the batch and trust gates that still apply to dry runs', () => {
  for (const doc of releaseDocs([upgrade, faq, security])) {
    expect(doc).toContain('Dry runs still require `filemaker.features.batch.enabled` and a trusted folder');
    expect(doc).toMatch(/(?:row cap applies to dry runs|including dry runs)/);
  }
});

it('documents Windows executable layout requirements without requiring a shared PATH entry', () => {
  for (const doc of releaseDocs([upgrade, troubleshooting, 'extension/docs/FM_WEB.md', faq, guide, security])) {
    expect(doc).toContain('absolute PATH entries');
    expect(doc).toContain('`node.exe`');
    expect(doc).toContain('`node_modules\\npm\\bin\\npm-cli.js`');
    expect(doc).toContain('On macOS and Linux, the preview runs `npm` from PATH');
  }
});

it('includes the local v1.8.0 tag and reported release assets in release guidance', () => {
  for (const doc of releaseDocs(['docs/RELEASE.md', 'docs/JOB_AID_MANUAL_RELEASE.md'])) {
    expect(doc).toMatch(/Tags `v1\.0\.0`, `v1\.1\.0`, `v1\.6\.0` and `v1\.8\.0`/);
    expect(doc).toContain('`SHA256SUMS.txt` and `sourcemaps-v1.8.0.tgz`');
  }
});

it('documents both age and process-id checks for stale preview cleanup', () => {
  for (const doc of releaseDocs(changelogs)) {
    expect(doc).toMatch(/older than one day.*extension-host process.*process id/);
    expect(doc).not.toContain('only when their VS Code window has closed');
  }
});

it('documents serialized script prompts and the bounded Windows stop operation', () => {
  for (const doc of releaseDocs([upgrade, 'extension/CHANGELOG.md'])) {
    expect(doc).toContain('Only one script prompt can be open at a time');
    expect(doc).toContain('5 seconds after it closes');
    expect(doc).toContain('`taskkill` with a 5 second limit');
    expect(doc).toContain('warning if stopping the previous preview fails');
  }
});
