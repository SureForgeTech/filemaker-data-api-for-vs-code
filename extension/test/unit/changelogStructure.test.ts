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
    const ignores = release.split('\n').filter((line) => /offline metadata cache.*ignore.*Git/i.test(line));
    expect(ignores).toHaveLength(1);
    expect(ignores[0]).toMatch(/snapshots (?:are not ignored|remain available to commit)/);
    const deadlines = release.split('\n').filter((line) => /upload.*(?:deadline|ceiling)/i.test(line));
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toMatch(/(?:deadline.*grow.*size|deadline that grows with the size)/);
    expect(deadlines[0]).toMatch(/30 minute(?:s| ceiling)/);
    expect(deadlines[0]).toMatch(/stalled/i);
  }
  expect(readExtension('CHANGELOG.md').split('\n## Unreleased\n')[1]?.split('\n## ')[0]?.trim()).toBe('');
  const unreleased = readRoot('CHANGELOG.md').split('\n## Unreleased\n')[1]?.split('\n## ')[0] ?? '';
  expect(unreleased.match(/^- None\.$/gm)).toHaveLength(5);
  expect(unreleased.match(/^- /gm)).toHaveLength(5);
});
