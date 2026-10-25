import { readFileSync } from 'fs';
import { resolve } from 'path';
import { expect, it } from 'vitest';

const HOOK =
  'Connect to any FileMaker Data API server and run queries, browse schema, edit records, and export results — without leaving VS Code.';

it('carries the Marketplace hook in the description and keeps the Cloud limitation in the README', () => {
  const { description } = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { description: string };
  expect(description).toBe(HOOK);
  expect(description.length).toBeLessThanOrEqual(140);

  const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf8');
  expect(readme).toContain('FileMaker Cloud sign-in with a Claris ID is not supported yet');

  expect(description).not.toMatch(/Server and FileMaker Cloud/);
});
