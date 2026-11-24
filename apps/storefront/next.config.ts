import type { NextConfig } from 'next';
import { mediaRemotePatterns, parseMediaOrigins } from './lib/media';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets a second local instance (e.g. the commerce mock on another port) use its own build dir.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@storeplix/types', '@storeplix/config', '@storeplix/themes'],
  async redirects() {
    return [
      // Phase 3 navigation builtins / collection links → the Phase 5 routes (PHASE-5-CONTRACT §5).
      { source: '/track-order', destination: '/track', permanent: true },
      { source: '/collections/:slug', destination: '/c/:slug', permanent: true },
    ];
  },
  images: {
    // Exact media origins from STOREFRONT_MEDIA_ORIGINS (read at build time). No wildcards.
    remotePatterns: mediaRemotePatterns(),
    // Next 16 refuses to optimize images from local IPs; local dev serves media from the API on
    // localhost:8010. Never in production builds.
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== 'production' && parseMediaOrigins().some((o) => o.hostname === 'localhost' || o.hostname === '127.0.0.1'),
  },
};

export default nextConfig;
