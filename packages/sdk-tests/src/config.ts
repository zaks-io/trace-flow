export const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:8787';
export const OBSERVE_API_KEY = process.env.OBSERVE_API_KEY;

if (!OBSERVE_API_KEY) {
  console.error('Error: OBSERVE_API_KEY environment variable is required');
  console.error('Set it in packages/sdk-tests/.env or export it in your shell');
  process.exit(1);
}

export const proxyHeaders = { 'X-Observe-Api-Key': OBSERVE_API_KEY };

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: ${name} environment variable is required`);
    process.exit(1);
  }
  return value;
}

export function log(provider: string, message: string) {
  console.log(`[${provider}] ${message}`);
}

export function success(provider: string, message: string) {
  console.log(`[${provider}] ✓ ${message}`);
}

export function error(provider: string, message: string) {
  console.error(`[${provider}] ✗ ${message}`);
}
