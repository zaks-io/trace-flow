import { describe, expect, it } from 'vitest';
import {
  boundedSSEMetadataValue,
  isBoundedSSEEventData,
  MAX_SSE_EVENT_DATA_LENGTH,
} from '../sse-state';

describe('SSE state bounds', () => {
  it('measures event data and metadata limits in UTF-8 bytes', () => {
    expect(isBoundedSSEEventData('é'.repeat(MAX_SSE_EVENT_DATA_LENGTH / 2))).toBe(true);
    expect(isBoundedSSEEventData('é'.repeat(MAX_SSE_EVENT_DATA_LENGTH / 2 + 1))).toBe(false);
    expect(boundedSSEMetadataValue('😀'.repeat(64))).toBeDefined();
    expect(boundedSSEMetadataValue('😀'.repeat(65))).toBeUndefined();
  });
});
