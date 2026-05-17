import type { LLMError } from '@trace-flow/types';
import { ERROR_ATTRS } from '../keys';

export function errorAttributes(error: LLMError): Record<string, string> {
  const out: Record<string, string> = {};
  if (error.type) out[ERROR_ATTRS.TYPE] = error.type;
  if (error.code) out[ERROR_ATTRS.CODE] = error.code;
  return out;
}
