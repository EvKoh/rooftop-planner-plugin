import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js'],
      reporter: ['text', 'text-summary'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});
