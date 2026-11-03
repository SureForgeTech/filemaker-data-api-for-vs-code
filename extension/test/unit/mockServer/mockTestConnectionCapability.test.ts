import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, type RunningMock, startMockProcess } from './mockHelper';

// The mock answers the two server-level calls Test Connection makes before it signs in
// (GET /productInfo and GET /databases). The documentation used to say it did not, so the
// claims are checked against the running mock here: a doc line that denies a capability the
// mock has is caught by this test rather than by a reader.

// A line that says the mock lacks one of these calls.
const staleClaim =
  /(?:does|do)\s*n[o']t\s+(?:yet\s+)?implement|doesn'?t\s+(?:yet\s+)?implement|not\s+yet\s+implement|stops\s+at\s+step\s+1|cannot\s+pass\s+step\s+1|answers?\s+404/i;

// A line that talks about one of the calls Test Connection makes.
const mentionsCall = /productinfo|\bdatabases\b/i;

const repoRoot = path.resolve(__dirname, '../../../..');
const skippedDirs = new Set([
  '.git',
  '.vscode-test',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'node_modules'
]);

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skippedDirs.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (entry.toLowerCase().endsWith('.md')) found.push(full);
  }
  return found;
}

const readLines = (file: string): string[] => readFileSync(file, 'utf8').split(/\r?\n/);

let mock: RunningMock;
let http: ReturnType<typeof api>;

beforeAll(async () => {
  mock = await startMockProcess();
  http = api(mock.baseUrl);
}, 30000);
afterAll(async () => mock?.stop());

describe('the mock answers the calls Test Connection makes', () => {
  it('GET /productInfo returns the product name and version, with no account', async () => {
    const info = await http.call('GET', '/productInfo');
    expect(info.status).toBe(200);
    expect(info.body.messages[0]).toEqual({ code: '0', message: 'OK' });
    expect(info.body.response.productInfo.name).toBe('FileMaker Data API Engine');
    expect(info.body.response.productInfo.version).toBe('22.0.1');
  });

  it('GET /databases lists the hosted databases', async () => {
    const dbs = await http.call('GET', '/databases');
    expect(dbs.status).toBe(200);
    expect(dbs.body.messages[0]).toEqual({ code: '0', message: 'OK' });
    expect(dbs.body.response.databases.map((d: { name: string }) => d.name)).toEqual(
      expect.arrayContaining(['Sales', 'Quality', 'Inventory'])
    );
  });
});

describe('the documentation matches what the mock does', () => {
  it('no markdown file claims the mock lacks these calls', () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(repoRoot)) {
      readLines(file).forEach((line, index) => {
        if (mentionsCall.test(line) && staleClaim.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    'extension/CONTRIBUTING.md',
    'extension/docs/QA/SMOKE_TEST.md',
    'docs/RELEASE.md'
  ])('%s says the mock supports these calls', (relative) => {
    const lines = readLines(path.join(repoRoot, relative));
    const aboutTheMock = lines.filter((line) => mentionsCall.test(line) && /mock/i.test(line));
    expect(aboutTheMock.length, `${relative} has no line about the mock and these calls`).toBeGreaterThan(0);
    expect(
      aboutTheMock.filter((line) => staleClaim.test(line)),
      `${relative} still denies the mock a capability it has`
    ).toEqual([]);
  });
});
