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
  async redirects() {
    return [
      {
        source: '/install.sh',
        destination:
          'https://github.com/zaks-io/trace-flow/releases/download/trace-flow-cli-v0.1.1/trace-flow-cli-installer.sh',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
