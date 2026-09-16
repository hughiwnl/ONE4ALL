import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['./test/integration/global-setup.ts'],
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
