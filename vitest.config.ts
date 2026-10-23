import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-database.ts'],
    ...(process.env.TEST_LIBSQL_URL ? { fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } : {}),
    coverage: {
      provider: 'v8',
      include: [
        'server.ts',
        'server/**/*.ts',
        'lib/**/*.ts',
        'src/**/*.{ts,tsx}',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 63.33,
        branches: 52.04,
        functions: 64.34,
        lines: 65.72,
      },
    },
  },
});
