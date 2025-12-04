import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load environment variables from .env.local file
function loadEnvFile() {
  // Check both local and root .env.local
  const paths = [
    resolve(process.cwd(), '.env.local'),
  ];
  for (const envPath of paths) {
    try {
      const envFile = readFileSync(envPath, 'utf-8');
      const env = {};
      envFile.split('\n').forEach((line) => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim().replace(/^["']|["']$/g, '');
          env[key] = value;
        }
      });
      return env;
    } catch {
      continue;
    }
  }
  console.warn('Could not load .env.local from any location');
  return {};
}

const fileEnv = loadEnvFile();

// Merge file env with process.env (process.env takes precedence for CI)
const env = {
  NEXT_PUBLIC_AUTH0_DOMAIN:
    process.env.NEXT_PUBLIC_AUTH0_DOMAIN || fileEnv.NEXT_PUBLIC_AUTH0_DOMAIN || '',
  NEXT_PUBLIC_AUTH0_CLIENT_ID:
    process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID || fileEnv.NEXT_PUBLIC_AUTH0_CLIENT_ID || '',
  NEXT_PUBLIC_CONVEX_URL:
    process.env.NEXT_PUBLIC_CONVEX_URL || fileEnv.NEXT_PUBLIC_CONVEX_URL || '',
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || fileEnv.NEXT_PUBLIC_API_URL || '',
  NEXT_PUBLIC_TINYBIRD_API_URL:
    process.env.NEXT_PUBLIC_TINYBIRD_API_URL || fileEnv.NEXT_PUBLIC_TINYBIRD_API_URL || '',
};

export default defineConfig({
  integrations: [react()],
  output: 'server',
  adapter: cloudflare({
    mode: 'directory',
    platformProxy: {
      enabled: true,
    },
  }),
  vite: {
    plugins: [tailwindcss()],
    define: {
      'import.meta.env.NEXT_PUBLIC_AUTH0_DOMAIN': JSON.stringify(env.NEXT_PUBLIC_AUTH0_DOMAIN),
      'import.meta.env.NEXT_PUBLIC_AUTH0_CLIENT_ID': JSON.stringify(env.NEXT_PUBLIC_AUTH0_CLIENT_ID),
      'import.meta.env.NEXT_PUBLIC_CONVEX_URL': JSON.stringify(env.NEXT_PUBLIC_CONVEX_URL),
      'import.meta.env.NEXT_PUBLIC_API_URL': JSON.stringify(env.NEXT_PUBLIC_API_URL),
      'import.meta.env.NEXT_PUBLIC_TINYBIRD_API_URL': JSON.stringify(
        env.NEXT_PUBLIC_TINYBIRD_API_URL
      ),
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  },
});
