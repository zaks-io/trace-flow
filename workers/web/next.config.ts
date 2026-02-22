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
};

export default nextConfig;
