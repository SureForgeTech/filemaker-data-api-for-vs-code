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
      // Floor at the measured level (2026-11-01): statements 72.77%, branches 64.34%,
      // functions 81.98%, lines 72.76%. Every source file stays included, including
      // the Next.js shell under app/ that the unit tests do not execute.
      // Raise the floors as coverage grows; never lower them to make a PR pass.
      thresholds: {
        lines: 72.7,
        statements: 72.7,
        functions: 81.9,
        branches: 64.3
      }
    }
  }
});
