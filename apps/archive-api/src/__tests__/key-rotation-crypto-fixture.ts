import {
  createArchiveEncryptionKeyVersion,
  serializeArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
} from '@trace-flow/utils';

const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

export async function digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, bytes.length);
    const chars = new Array<string>(end - offset);
    for (let index = offset; index < end; index++) {
      chars[index - offset] = String.fromCharCode(bytes[index]!);
    }
    binary += chars.join('');
  }
  return btoa(binary);
}

export async function wrapKey(orgId: string, keyVersion: number): Promise<string> {
  return serializeArchiveWrappedKeyVersion(
    await createArchiveEncryptionKeyVersion({
      orgId,
      keyVersion,
      wrappingSecretBase64: WRAPPING_SECRET,
    }),
  );
}

export async function cryptoKey(
  orgId: string,
  keyVersion: number,
  wrappedKey: string,
): Promise<CryptoKey> {
  return unwrapArchiveEncryptionKey(JSON.parse(wrappedKey), {
    orgId,
    keyVersion,
    wrappingSecretBase64: WRAPPING_SECRET,
  });
}

export async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
