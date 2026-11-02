import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      // Floor at the measured level (2026-11-01): statements 95.20%, branches 87.08%,
      // functions 96.66%, lines 96.99%. Every source file stays included.
      // Raise the floors as coverage grows; never lower them to make a PR pass.
      thresholds: {
        lines: 96,
        statements: 95,
        functions: 96,
        branches: 87
      }
    }
  }
});
