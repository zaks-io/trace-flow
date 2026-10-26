import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PageScripts {
  hashes: string[];
  external: Record<string, string>;
}

const hash = (content: string | Buffer) =>
  `sha384-${createHash('sha384').update(content).digest('base64')}`;

export async function collectPageScripts(
  html: string,
  readScript: (src: string) => Promise<Buffer>,
): Promise<PageScripts> {
  const hashes = new Set<string>();
  const external: Record<string, string> = {};

  // Next's generated HTML escapes script contents. Match raw script text so its
  // digest covers the exact bytes the browser checks, including whitespace.
  for (const [, attributes, content] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = attributes.match(/\bsrc="([^"]+)"/i)?.[1];
    if (src) {
      if (!src.startsWith('/_next/static/') || src.includes('..')) {
        throw new Error(`Unexpected prerendered script source: ${src}`);
      }
      external[src] ??= hash(await readScript(src));
    } else {
      hashes.add(hash(content));
    }
  }

  return { hashes: [...hashes], external };
}

async function generatePublicCsp() {
  const nextDir = path.resolve('.next');
  const appDir = path.join(nextDir, 'server/app');
  const files = await readdir(appDir, { recursive: true });
  const pages: Record<string, PageScripts> = {};

  for (const file of files.filter((file) => file.endsWith('.html'))) {
    const route = file === 'index.html' ? '/' : `/${file.slice(0, -5)}`;
    pages[route] = await collectPageScripts(
      await readFile(path.join(appDir, file), 'utf8'),
      (src) => readFile(path.join(nextDir, src.slice('/_next/'.length))),
    );
  }

  for (const route of ['/', '/terms', '/privacy', '/security', '/docs']) {
    if (!pages[route]) throw new Error(`Required public route was not prerendered: ${route}`);
  }
  await writeFile(path.join(nextDir, 'public-csp.json'), JSON.stringify(pages));
  console.log(`Generated script protection for ${Object.keys(pages).length} static HTML routes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generatePublicCsp();
}
