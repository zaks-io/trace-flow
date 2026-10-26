import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error('Usage: bun run scripts/verify-worker.ts <local-worker-url>');

const publicPaths = ['/', '/terms', '/privacy', '/security', '/docs', '/docs/quick-start'];
const fetchWorker = (pathname: string, init: RequestInit = {}) =>
  fetch(new URL(pathname, baseUrl), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

for (const pathname of [...publicPaths, '/docs/%71uick-start']) {
  const response = await fetchWorker(pathname);
  assert.equal(response.status, 200, pathname);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const csp = response.headers.get('content-security-policy-report-only');
  assert(csp, `${pathname}: missing CSP`);
  assert(csp.includes("'strict-dynamic'"), `${pathname}: missing strict CSP`);
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert(nonce, `${pathname}: missing nonce`);
  assert(
    !csp
      .split(';')
      .find((part) => part.trim().startsWith('script-src'))
      ?.includes("'unsafe-inline'"),
  );
  const html = await response.text();
  let scriptCount = 0;
  for (const [, attributes, content] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    scriptCount++;
    const src = attributes.match(/\bsrc="([^"]+)"/i)?.[1];
    if (src) {
      assert(attributes.includes(`nonce="${nonce}"`), `${pathname}: unprotected external script`);
      const integrity = attributes.match(/\bintegrity="([^"]+)"/i)?.[1];
      const script = await fetchWorker(src);
      assert.equal(script.status, 200, src);
      const digest = createHash('sha384')
        .update(Buffer.from(await script.arrayBuffer()))
        .digest('base64');
      assert.equal(integrity, `sha384-${digest}`, `${pathname}: wrong external integrity`);
    } else {
      const digest = createHash('sha384').update(content).digest('base64');
      assert(csp.includes(`'sha384-${digest}'`), `${pathname}: unprotected inline script`);
    }
  }
  assert(scriptCount > 0, `${pathname}: missing framework scripts`);
  const second = await fetchWorker(pathname);
  assert(!second.headers.get('content-security-policy-report-only')?.includes(`'nonce-${nonce}'`));
  await second.body?.cancel();
  console.log(`${pathname}: 200, fresh strict CSP, ${scriptCount} protected scripts`);
}

const homepage = await fetchWorker('/');
assert(homepage.headers.get('link')?.includes('rel="api-catalog"'));
assert(homepage.headers.get('vary')?.toLowerCase().includes('accept'));
await homepage.body?.cancel();

for (const pathname of [
  '/llms.txt',
  '/.well-known/api-catalog',
  '/.well-known/ai-catalog.json',
  '/.well-known/mcp/server-card.json',
  '/.well-known/agent-skills/index.json',
  '/docs/quick-start.md',
]) {
  const response = await fetchWorker(pathname);
  assert.equal(response.status, 200, pathname);
  await response.body?.cancel();
}

const resourceMetadata = await fetchWorker('/.well-known/oauth-protected-resource');
assert.equal(resourceMetadata.status, 307);
assert.equal(
  new URL(resourceMetadata.headers.get('location')!).pathname,
  '/.well-known/oauth-protected-resource',
);
await resourceMetadata.body?.cancel();

for (const pathname of [
  '/_next/static/missing.js',
  '/favicon.svg/missing',
  '/robots.txt/missing',
  '/docs/missing',
]) {
  const response = await fetchWorker(pathname);
  assert.equal(response.status, 404, pathname);
  await response.body?.cancel();
}

for (const method of ['GET', 'HEAD']) {
  const response = await fetchWorker('/healthz', { method });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), method === 'HEAD' ? '' : '{"status":"ok"}');
}

const app = await fetchWorker('/app');
assert.equal(app.status, 307);
assert.equal(new URL(app.headers.get('location')!, baseUrl).pathname, '/auth/login');
await app.body?.cancel();
console.log('Discovery, machine paths, 404s, health probes and signed-out /app passed');
