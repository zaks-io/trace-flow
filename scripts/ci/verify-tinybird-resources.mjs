import { readdirSync } from 'node:fs';
import { RETIRED_RESOURCES } from './tinybird-destructive-diff.mjs';

export async function verifyTinybirdResources({
  host = process.env.TB_HOST,
  token = process.env.TB_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!host || !token) throw new Error('TB_HOST and TB_TOKEN are required');
  for (const [kind, directories, extension] of [
    ['datasources', ['datasources'], '.datasource'],
    ['pipes', ['pipes', 'materializations', 'copies'], '.pipe'],
  ]) {
    const response = await fetchImpl(new URL(`/v0/${kind}?attrs=name`, host), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(`Tinybird ${kind} verification failed: HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result[kind])) throw new Error(`Tinybird returned no ${kind} inventory`);
    const names = new Set(result[kind].map(({ name }) => name));
    for (const directory of directories) {
      for (const file of readdirSync(directory).filter((name) => name.endsWith(extension))) {
        const name = file.slice(0, -extension.length);
        if (!names.has(name)) throw new Error(`Missing live Tinybird resource: ${name}`);
      }
    }
    for (const name of RETIRED_RESOURCES[kind]) {
      if (names.has(name)) throw new Error(`Retired Tinybird resource still present: ${name}`);
    }
  }
  const tokenResponse = await fetchImpl(new URL('/v0/tokens', host), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tokenResponse.ok)
    throw new Error(`Tinybird token verification failed: HTTP ${tokenResponse.status}`);
  const tokenInventory = await tokenResponse.json();
  if (!Array.isArray(tokenInventory.tokens))
    throw new Error('Tinybird returned no token inventory');
  for (const name of RETIRED_RESOURCES.tokens) {
    if (tokenInventory.tokens.some((entry) => entry.name === name))
      throw new Error(`Retired Tinybird token still present: ${name}`);
  }
}
if (process.argv[1]?.endsWith('/verify-tinybird-resources.mjs')) {
  await verifyTinybirdResources();
  console.log('Live Tinybird resources present and retired resources absent.');
}
