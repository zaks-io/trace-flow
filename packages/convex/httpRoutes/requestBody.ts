import { readRequestBodyWithLimit } from '@trace-flow/utils';

const decoder = new TextDecoder();

export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  return decoder.decode(await readRequestBodyWithLimit(request, maxBytes));
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedText(request, maxBytes));
}
