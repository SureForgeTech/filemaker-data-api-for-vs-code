import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Client code uses only the authenticated same-origin proxy.
const read = (...parts: string[]): string => readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8');

describe('bridge token wiring', () => {
  it('keeps the token and server environment out of the data hook and layout client', () => {
    for (const file of [['lib', 'runtime-data.ts'], ['app', 'layouts', '[id]', 'runtime-layout-client.tsx']]) {
      const source = read(...file);
      expect(source).toContain("'/api/bridge'");
      expect(source).not.toMatch(/process\.env|bridgeToken:/);
    }
  });

  it('runtime-behavior hands the token to the client', () => {
    expect(read('lib', 'runtime-behavior.ts')).toMatch(
      /new RuntimeBridgeClient\(context\.bridgeBaseUrl,\s*context\.fetchFn,\s*context\.bridgeToken\)/
    );
  });

  it('every managed file carries the template version marker', () => {
    for (const file of [
      ['lib', 'bridge-client.ts'],
      ['lib', 'runtime-data.ts'],
      ['lib', 'runtime-behavior.ts'],
      ['app', 'layouts', '[id]', 'runtime-layout-client.tsx']
    ]) {
      expect(read(...file).split('\n', 1)[0], file.join('/')).toMatch(/^\/\/ fmweb-managed: runtime template v\d+/);
    }
  });
});
