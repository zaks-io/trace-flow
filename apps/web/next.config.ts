import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { generateDocsContent } from './scripts/generate-docs-content';
import { generateAgentSkills } from './scripts/generate-agent-skills';

// Bundle docs/*.md into JS at build time. The /docs/[slug] page reads from
// the generated module, so there is no fs/fetch/ASSETS dependency at runtime
// on Cloudflare Workers.
generateDocsContent();

// Bundle skills/*/SKILL.md plus a digest of their exact bytes, so the discovery
// index and the artifacts it points at are generated from one read.
generateAgentSkills();

void initOpenNextCloudflareForDev({ remoteBindings: false });

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  transpilePackages: ['@trace-flow/convex', '@trace-flow/utils', '@trace-flow/emails'],
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

export default withSentryConfig(nextConfig, {
  org: 'zaksio',
  project: 'trace-flow',
  authToken: sentryAuthToken,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: {
    disable: !sentryAuthToken,
    deleteSourcemapsAfterUpload: true,
  },
  widenClientFileUpload: true,
  disableLogger: true,
});
