import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { collectPageScripts } from '../generate-public-csp';

describe('prerendered script protection', () => {
  it('hashes exact inline bytes and the contents of external build assets', async () => {
    const inline = '\nself.__next_f.push([1,"hello"]);\n';
    const external = Buffer.from('console.log("built asset")');
    const readScript = vi.fn().mockResolvedValue(external);
    const result = await collectPageScripts(
      `<script src="/_next/static/chunks/app.js" async></script><script>${inline}</script>`,
      readScript,
    );
    expect(result.hashes).toEqual([
      `sha384-${createHash('sha384').update(inline).digest('base64')}`,
    ]);
    expect(result.external).toEqual({
      '/_next/static/chunks/app.js': `sha384-${createHash('sha384').update(external).digest('base64')}`,
    });
    expect(readScript).toHaveBeenCalledWith('/_next/static/chunks/app.js');
  });

  it('does not authorize arbitrary external scripts or traversal paths', async () => {
    for (const src of ['https://untrusted.example/script.js', '/_next/static/../../private.js']) {
      await expect(collectPageScripts(`<script src="${src}"></script>`, vi.fn())).rejects.toThrow(
        'Unexpected prerendered script source',
      );
    }
  });

  it('fails the build when a referenced script is missing', async () => {
    await expect(
      collectPageScripts('<script src="/_next/static/missing.js"></script>', async () => {
        throw new Error('missing build asset');
      }),
    ).rejects.toThrow('missing build asset');
  });
});
