import type { NextConfig } from 'next';
import { mediaRemotePatterns } from './lib/media';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@storeplix/types', '@storeplix/config', '@storeplix/themes'],
  images: {
    // Exact media origins from STOREFRONT_MEDIA_ORIGINS (read at build time). No wildcards.
    remotePatterns: mediaRemotePatterns(),
  },
};

export default nextConfig;
