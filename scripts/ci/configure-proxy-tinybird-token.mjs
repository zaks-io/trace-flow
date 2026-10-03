import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_NAME = 'trace_flow_proxy_spans_append';
const TOKEN_SCOPE = 'DATASOURCES:APPEND:otel_trace_spans';

export async function configureProxyTinybirdToken(outputPath) {
  const host = process.env.TB_HOST;
  const adminToken = process.env.TB_TOKEN;
  if (!outputPath || !host || !adminToken) {
    throw new Error('Output path, TB_HOST, and TB_TOKEN are required');
  }

  const request = async (path, init = {}) => {
    const response = await fetch(new URL(path, host), {
      ...init,
      headers: { Authorization: `Bearer ${adminToken}`, ...init.headers },
    });
    if (!response.ok) {
      throw new Error(`Tinybird trace token request failed: HTTP ${response.status}`);
    }
    return response.json();
  };

  const listing = await request('/v0/tokens');
  if (!Array.isArray(listing.tokens)) throw new Error('Tinybird returned no token inventory');
  const matches = listing.tokens.filter((token) => token.name === TOKEN_NAME);
  if (matches.length > 1) throw new Error('Tinybird returned duplicate trace append tokens');
  // Preview uses the existing dev schema, so credential setup cannot depend on a schema deployment.
  let token = matches[0];
  if (!token) {
    await request('/v0/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: TOKEN_NAME, scope: TOKEN_SCOPE }),
    });
    token = await request(`/v0/tokens/${TOKEN_NAME}`);
  }
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
  await writeFile(outputPath, `TINYBIRD_TOKEN=${token.token}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await configureProxyTinybirdToken(process.argv[2]);
  console.log('Exported scoped Proxy Tinybird token.');
}
