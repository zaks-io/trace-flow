import { describe, expect, it } from 'vitest';
import { sortTooltipPayload } from '../chart';

describe('sortTooltipPayload', () => {
  it('orders numeric tooltip values descending through an item sorter', () => {
    const payload = [{ value: 0.926 }, { value: 1300 }, { value: 2.12 }];

    expect(sortTooltipPayload(payload, (item) => -item.value)).toEqual([
      { value: 1300 },
      { value: 2.12 },
      { value: 0.926 },
    ]);
  });

  it('preserves payload order without an item sorter', () => {
    const payload = [{ value: 2 }, { value: 1 }];

    expect(sortTooltipPayload(payload)).toBe(payload);
  });
});
