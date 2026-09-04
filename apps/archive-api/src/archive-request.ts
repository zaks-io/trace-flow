import { ArchiveContractError } from './archive-contract';

export const MAX_ARCHIVE_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_COMMIT_BYTES = 9 * 1024 * 1024;

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
  tooLargeError: string,
): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ArchiveContractError('invalid_json');
    }
    if (length > maxBytes) throw new ArchiveContractError(tooLargeError);
  }
  if (!request.body) throw new ArchiveContractError('invalid_json');
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) throw new ArchiveContractError('invalid_json');
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ArchiveContractError(tooLargeError);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new ArchiveContractError('invalid_json');
  }
}
