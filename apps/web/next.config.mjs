// Plain JavaScript on purpose: `next start` would otherwise need TypeScript at
// runtime to load a next.config.ts. Configuration (including the root .env) is
// loaded lazily by src/server/container.ts.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources; let Next compile them.
  transpilePackages: [
    '@repeat/auth',
    '@repeat/config',
    '@repeat/core',
    '@repeat/database',
    '@repeat/provider-sdk',
    '@repeat/provider-mock',
    '@repeat/provider-youtube',
    '@repeat/provider-meta',
    '@repeat/providers',
    '@repeat/queue',
    '@repeat/types',
  ],
  // Native/runtime-only packages must not be bundled by webpack/turbopack.
  serverExternalPackages: ['@prisma/client', 'pino', 'pino-pretty', 'bullmq', 'ioredis'],
  // Workspace packages use ESM-style ".js" import specifiers for TypeScript
  // sources; teach webpack to resolve them (Turbopack does this natively).
  webpack(config) {
    // Optional BullMQ backend that is not installed; stop webpack from trying to resolve it.
    config.resolve.alias = { ...config.resolve.alias, '@valkey/valkey-glide': false };
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
