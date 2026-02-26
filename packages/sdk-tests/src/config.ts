export const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:8787';
const TRACE_FLOW_API_KEY = process.env.TRACE_FLOW_API_KEY;

export function ensureTraceFlowKey(): void {
  if (!TRACE_FLOW_API_KEY) {
    console.error('Error: TRACE_FLOW_API_KEY environment variable is required');
    console.error('Set it in packages/sdk-tests/.env or export it in your shell');
    process.exit(1);
  }
}

export function getProxyHeaders(): Record<string, string> {
  ensureTraceFlowKey();
  return { 'X-Trace-Flow-Api-Key': TRACE_FLOW_API_KEY! };
}

export const proxyHeaders: Record<string, string> = {
  get ['X-Trace-Flow-Api-Key']() {
    ensureTraceFlowKey();
    return TRACE_FLOW_API_KEY!;
  },
};

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
