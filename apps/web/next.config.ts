import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { generateDocsContent } from './scripts/generate-docs-content';

// Bundle docs/*.md into JS at build time. The /docs/[slug] page reads from
// the generated module, so there is no fs/fetch/ASSETS dependency at runtime
// on Cloudflare Workers.
generateDocsContent();

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
