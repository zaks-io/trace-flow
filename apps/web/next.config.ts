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

// Next blocks cross-origin dev assets by default. scripts/dev/local-stack.sh serves Web on
// a tailnet hostname so reviewers can open it from another machine.
const allowedDevOrigins = process.env.TRACE_FLOW_ALLOWED_DEV_ORIGINS?.split(',').filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(allowedDevOrigins?.length ? { allowedDevOrigins } : {}),
  reactCompiler: true,
  transpilePackages: ['@trace-flow/convex', '@trace-flow/utils', '@trace-flow/emails'],
  experimental: {
    optimizePackageImports: ['recharts'],
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
