import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@fmweb/shared': path.resolve(__dirname, '../shared/src/index.ts')
    }
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
      // Floor at the current level (2026-10-24): statements 67.88%, branches 59.06%,
      // functions 70.56%, lines 66.99%. Every source file stays included.
      // Raise the floors as coverage grows; never lower them to make a PR pass.
      thresholds: {
        lines: 66,
        statements: 67,
        functions: 70,
        branches: 59
      }
    }
  }
});
