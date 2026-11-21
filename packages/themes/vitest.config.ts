import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const storefront = fileURLToPath(new URL('../../apps/storefront/', import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      // The Zod parity test imports the storefront theme engine directly (no package dependency).
      '@/': storefront,
      'server-only': fileURLToPath(new URL('../../apps/storefront/tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
