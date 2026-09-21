import { defineConfig } from 'vitest/config';

/**
 * Every workspace package publishes a `development` export condition that points at
 * TypeScript source. Running the suite with that condition means tests execute against
 * source without a prior `tsc -b`, while production resolution still uses `dist`.
 */
export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/server/test/**/*.test.ts',
      'tools/**/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
  },
});
