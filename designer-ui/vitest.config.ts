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
      // Floor at the measured level (2026-11-01): statements 67.94%, branches 59.19%,
      // functions 70.56%, lines 67.02%. Every source file stays included.
      // Raise the floors as coverage grows; never lower them to make a PR pass.
      thresholds: {
        lines: 67,
        statements: 67.9,
        functions: 70.5,
        branches: 59.1
      }
    }
  }
});
