import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_NAME = 'trace_flow_proxy_spans_append';

export async function configureProxyTinybirdToken(outputPath) {
  const host = process.env.TB_HOST;
  const adminToken = process.env.TB_TOKEN;
  if (!outputPath || !host || !adminToken) {
    throw new Error('Output path, TB_HOST, and TB_TOKEN are required');
  }

  const response = await fetch(new URL('/v0/tokens', host), {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) {
    throw new Error(`Tinybird trace token request failed: HTTP ${response.status}`);
  }
  const listing = await response.json();
  if (!Array.isArray(listing.tokens)) throw new Error('Tinybird returned no token inventory');
  const matches = listing.tokens.filter((token) => token.name === TOKEN_NAME);
  if (matches.length > 1) throw new Error('Tinybird returned duplicate trace append tokens');
  const token = matches[0];
  if (!token) throw new Error('Deploy the trace_flow_proxy_spans_append datafile token first');
  if (
    token.scopes?.length !== 1 ||
    token.scopes[0].type !== 'DATASOURCES:APPEND' ||
    token.scopes[0].resource !== 'otel_trace_spans' ||
    typeof token.token !== 'string' ||
    !token.token ||
    /[\r\n]/.test(token.token)
  ) {
    throw new Error('Tinybird trace append token has invalid scopes or value');
  }
  const file = await open(outputPath, 'w', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`TINYBIRD_TOKEN=${token.token}\n`);
  } finally {
    await file.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await configureProxyTinybirdToken(process.argv[2]);
  console.log('Exported scoped Proxy Tinybird token.');
}
