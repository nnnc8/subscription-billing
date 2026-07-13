import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
