import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

void initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  transpilePackages: ['@trace-flow/utils', '@trace-flow/emails'],
  experimental: {
    optimizePackageImports: ['recharts'],
  },
  async rewrites() {
    return {
      beforeFiles: [{ source: '/agents.md', destination: '/docs/agents.md' }],
    };
  },
};

export default nextConfig;
