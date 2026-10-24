import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@fmweb/shared': path.resolve(__dirname, '../shared/src/index.ts') } },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
      exclude: ['lib/**/*.test.ts', 'next-env.d.ts'],
      // Floor at the current level (2026-10-24): statements 69.75%, branches 63.8%,
      // functions 78.37%, lines 69.51%. Every source file stays included, including
      // the Next.js shell under app/ that the unit tests do not execute.
      // Raise the floors as coverage grows; never lower them to make a PR pass.
      thresholds: {
        lines: 69,
        statements: 69,
        functions: 78,
        branches: 63
      }
    }
  }
});
