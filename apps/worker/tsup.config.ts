import { defineConfig } from 'tsup';

/**
 * Bundle the worker and all @repeat/* workspace packages into one ESM file.
 * Third-party runtime dependencies stay external and are resolved from the
 * worker's own node_modules, so they must be listed in apps/worker/package.json.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@repeat\//],
  external: ['@prisma/client', 'bullmq', 'ioredis', 'pino', 'pino-pretty', 'zod'],
});
