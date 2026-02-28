# Bug Fix: Cache Hit Rate Showing 100% When No Cache Data

## Problem

The cache hit rate badge on Trace Details displays 100% when there is no cache data present. This is misleading - if a request didn't use caching at all, showing 100% cache rate is incorrect.

## Investigation

Based on code analysis, cache metrics are tracked in OpenTelemetry span attributes:

- `gen_ai.usage.cache_read_input_tokens` - tokens served from cache
- `gen_ai.usage.cache_creation_input_tokens` - tokens added to cache
- `gen_ai.usage.input_tokens` - total input tokens

**File**: `apps/web/src/lib/traceToMarkdown.ts`

Current calculation pattern:

```typescript
const cacheRead = parseInt(attrs['gen_ai.usage.cache_read_input_tokens'] ?? '0', 10);
```

The issue is likely in the component displaying the badge, where:

- Cache rate = `cacheReadTokens / inputTokens * 100`
- When both are 0: `0 / 0 = NaN` which may render as 100%
- Or: dividing by 0 defaults to some value

## Root Cause Locations

Search for cache hit rate display in:

1. `TokenSummaryCards.tsx` - Summary cards on trace detail
2. `TraceDetailPanel.tsx` - Panel showing trace overview
3. `AgentGanttChart.tsx` - Gantt chart badges

## Fix

### 1. Add Helper Function

**File**: `apps/web/src/lib/metrics.ts`

```typescript
/**
 * Calculate cache hit rate from token counts.
 * Returns null if no meaningful cache data exists (neither reads nor creations).
 */
export function calculateCacheHitRate(
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalInputTokens: number,
): number | null {
  // No cache activity at all - return null to indicate N/A
  if (cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null;
  }

  // No input tokens but cache tokens exist - data inconsistency, return null
  if (totalInputTokens === 0) {
    return null;
  }

  // Valid calculation
  return (cacheReadTokens / totalInputTokens) * 100;
}
```

### 2. Update Display Components

**File**: `apps/web/src/components/TokenSummaryCards.tsx`

```typescript
import { calculateCacheHitRate } from '@/lib/metrics';

// In component
const cacheRate = calculateCacheHitRate(
  summary.cacheReadTokens,
  summary.cacheCreationTokens,
  summary.promptTokens
);

// In render
{
  cacheRate !== null ? <Card title="Cache Hit Rate" value={`${cacheRate.toFixed(1)}%`} /> : null;
} // Don't show card if no cache data
```

### 3. Update Badge Component (if separate)

If there's a dedicated cache badge component:

```typescript
interface CacheRateBadgeProps {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalInputTokens: number;
}

export function CacheRateBadge(props: CacheRateBadgeProps) {
  const rate = calculateCacheHitRate(
    props.cacheReadTokens,
    props.cacheCreationTokens,
    props.totalInputTokens
  );

  // Don't render badge if no cache data
  if (rate === null) return null;

  return <Badge variant={rate > 50 ? 'success' : 'default'}>{rate.toFixed(0)}% cached</Badge>;
}
```

### 4. Update Markdown Export

**File**: `apps/web/src/lib/traceToMarkdown.ts`

```typescript
// Current (line 349-353):
if (summary.cacheReadTokens > 0 || summary.cacheCreationTokens > 0) {
  const newTokens = Math.max(0, summary.promptTokens - summary.cacheReadTokens);
  lines.push(
    `| Cache | ${formatNumber(summary.cacheReadTokens)} cached / ${formatNumber(newTokens)} new |`,
  );
}

// This is already correct - it only shows cache info when there IS cache data.
// No changes needed here.
```

## Edge Cases to Handle

| Scenario              | cacheRead | cacheCreate | input | Expected Display  |
| --------------------- | --------- | ----------- | ----- | ----------------- |
| No cache at all       | 0         | 0           | 100   | Hide badge        |
| 100% cache hit        | 100       | 0           | 100   | 100%              |
| Partial cache         | 50        | 0           | 100   | 50%               |
| Cache miss + creation | 0         | 100         | 100   | 0% (or "warming") |
| Mixed                 | 50        | 50          | 100   | 50%               |
| No tokens (empty)     | 0         | 0           | 0     | Hide badge        |

## Testing

### Unit Tests

**File**: `apps/web/src/lib/__tests__/metrics.test.ts`

```typescript
import { calculateCacheHitRate } from '../metrics';

describe('calculateCacheHitRate', () => {
  it('returns null when no cache activity', () => {
    expect(calculateCacheHitRate(0, 0, 100)).toBeNull();
  });

  it('returns null when no tokens at all', () => {
    expect(calculateCacheHitRate(0, 0, 0)).toBeNull();
  });

  it('calculates correct percentage', () => {
    expect(calculateCacheHitRate(50, 0, 100)).toBe(50);
    expect(calculateCacheHitRate(100, 0, 100)).toBe(100);
    expect(calculateCacheHitRate(0, 100, 100)).toBe(0);
  });

  it('handles cache creation without reads', () => {
    // Cache warming - 0% hit rate but still valid to show
    expect(calculateCacheHitRate(0, 50, 100)).toBe(0);
  });
});
```

### Component Tests

```typescript
describe('CacheRateBadge', () => {
  it('does not render when no cache data', () => {
    render(
      <CacheRateBadge cacheReadTokens={0} cacheCreationTokens={0} totalInputTokens={100} />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders correct percentage when cache data exists', () => {
    render(
      <CacheRateBadge cacheReadTokens={75} cacheCreationTokens={0} totalInputTokens={100} />
    );
    expect(screen.getByText('75% cached')).toBeInTheDocument();
  });
});
```

## Acceptance Criteria

- [ ] Cache hit rate displays accurate percentage based on actual cache data
- [ ] When no cache data exists, badge/card is hidden (not 100%)
- [ ] Edge cases handled: zero tokens, cache creation without reads
- [ ] Unit tests for calculation logic
- [ ] Component tests for display behavior
- [ ] Manual QA: verify on traces with and without cache data
