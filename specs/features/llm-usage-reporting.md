# LLM Usage & Cost Reporting Page

## Overview

Add a new page to surface LLM usage and cost data from the existing Tinybird analytics infrastructure. The backend endpoints are already implemented; this spec covers the frontend implementation.

## Available Tinybird Endpoints

| Endpoint                | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `llm_usage_summary`     | Total requests, tokens (input/output/cached), cost for a range |
| `llm_usage_timeseries`  | Time series data with auto-granularity selection               |
| `llm_usage_by_model`    | Breakdown by model                                             |
| `llm_usage_by_provider` | Breakdown by provider                                          |

**Note**: All cost values are in micro-dollars (divide by 1,000,000 for display).

## Page Design

### Route

`/usage` - Add to main navigation in `AppSidebar.tsx`

### Layout

```
+-------------------------------------------------------------+
| [7d] [30d] [90d] [Custom v]           [Provider v] [Model v]|
+-------------------------------------------------------------+
| +-----------+ +-----------+ +-----------+ +---------------+ |
| | Requests  | | Tokens    | | Cost      | | Cache Savings | |
| | 12,345    | | 1.2M      | | $45.67    | | $12.34 (21%)  | |
| +-----------+ +-----------+ +-----------+ +---------------+ |
+-------------------------------------------------------------+
|                                                             |
|     Usage Over Time (Area Chart)                            |
|     [Tokens] [Cost] [Requests]                              |
|                                                             |
+-------------------------------------------------------------+
| +-------------------------+ +-----------------------------+ |
| | By Provider (Pie/Bar)   | | By Model (Table)            | |
| |                         | | Model      Reqs   Cost      | |
| |   OpenAI 65%            | | gpt-4o     5.2k   $32.10    | |
| |   Anthropic 35%         | | claude-3   2.1k   $12.50    | |
| +-------------------------+ +-----------------------------+ |
+-------------------------------------------------------------+
```

## Implementation

### 1. Create Tinybird Hooks

**File**: `workers/web/src/hooks/useLLMUsage.ts`

```typescript
import { useTinybirdQuery } from './useTinybirdQuery';

interface UsageFilters {
  startTime: number; // Unix timestamp
  endTime: number;
  provider?: string;
  model?: string;
  operation?: string;
}

export function useLLMUsageSummary(filters: UsageFilters) {
  return useTinybirdQuery('llm_usage_summary', {
    start_time_ns: filters.startTime * 1_000_000_000,
    end_time_ns: filters.endTime * 1_000_000_000,
    provider: filters.provider,
    model: filters.model,
    operation: filters.operation,
  });
}

export function useLLMUsageTimeseries(filters: UsageFilters) {
  return useTinybirdQuery('llm_usage_timeseries', {
    start_time_ns: filters.startTime * 1_000_000_000,
    end_time_ns: filters.endTime * 1_000_000_000,
    provider: filters.provider,
    model: filters.model,
  });
}

export function useLLMUsageByModel(filters: UsageFilters) {
  return useTinybirdQuery('llm_usage_by_model', {
    start_time_ns: filters.startTime * 1_000_000_000,
    end_time_ns: filters.endTime * 1_000_000_000,
    provider: filters.provider,
  });
}

export function useLLMUsageByProvider(filters: UsageFilters) {
  return useTinybirdQuery('llm_usage_by_provider', {
    start_time_ns: filters.startTime * 1_000_000_000,
    end_time_ns: filters.endTime * 1_000_000_000,
  });
}
```

### 2. Summary Cards Component

**File**: `workers/web/src/components/UsageSummaryCards.tsx`

```typescript
interface UsageSummaryCardsProps {
  data: {
    total_requests: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cost_microdollars: number;
  } | null;
  loading: boolean;
}

export function UsageSummaryCards({ data, loading }: UsageSummaryCardsProps) {
  // Format cost: microdollars to dollars
  const formatCost = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

  // Calculate cache savings percentage
  const cacheRate = data
    ? (data.total_cache_read_tokens / (data.total_input_tokens || 1)) * 100
    : 0;

  return (
    <div className="grid grid-cols-4 gap-4">
      <Card title="Total Requests" value={data?.total_requests} loading={loading} />
      <Card
        title="Total Tokens"
        value={formatTokens(data?.total_input_tokens + data?.total_output_tokens)}
      />
      <Card title="Total Cost" value={formatCost(data?.total_cost_microdollars || 0)} />
      <Card title="Cache Rate" value={`${cacheRate.toFixed(1)}%`} />
    </div>
  );
}
```

### 3. Time Series Chart

**File**: `workers/web/src/components/UsageChart.tsx`

Use Recharts (already in the project) for the time series visualization:

```typescript
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface UsageChartProps {
  data: Array<{
    bucket_time: string;
    total_requests: number;
    total_cost_microdollars: number;
  }>;
  metric: 'requests' | 'cost' | 'tokens';
}

export function UsageChart({ data, metric }: UsageChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <XAxis dataKey="bucket_time" tickFormatter={formatDate} />
        <YAxis tickFormatter={metric === 'cost' ? formatCost : formatNumber} />
        <Tooltip />
        <Area type="monotone" dataKey={getDataKey(metric)} fill="#8884d8" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

### 4. Main Page Component

**File**: `workers/web/src/components/pages/Usage.tsx`

```typescript
export function Usage() {
  const [dateRange, setDateRange] = useState<DateRange>(PRESETS['30d']);
  const [filters, setFilters] = useState<Filters>({});

  const summary = useLLMUsageSummary({ ...dateRange, ...filters });
  const timeseries = useLLMUsageTimeseries({ ...dateRange, ...filters });
  const byModel = useLLMUsageByModel({ ...dateRange, ...filters });
  const byProvider = useLLMUsageByProvider({ ...dateRange, ...filters });

  return (
    <div className="space-y-6">
      <div className="flex justify-between">
        <h1>Usage & Costs</h1>
        <div className="flex gap-2">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <ProviderFilter value={filters.provider} onChange={...} />
          <ModelFilter value={filters.model} onChange={...} />
        </div>
      </div>

      <UsageSummaryCards data={summary.data} loading={summary.isLoading} />
      <UsageChart data={timeseries.data} metric="cost" />

      <div className="grid grid-cols-2 gap-6">
        <ProviderBreakdown data={byProvider.data} />
        <ModelTable data={byModel.data} />
      </div>
    </div>
  );
}
```

### 5. Add Route & Navigation

**File**: `workers/web/src/App.tsx`

```typescript
<Route path="/usage" element={<Usage />} />
```

**File**: `workers/web/src/components/AppSidebar.tsx`

```typescript
{ icon: DollarSign, label: 'Usage', href: '/usage' },
```

## Future Enhancements (Nice to Have)

- [ ] CSV export functionality
- [ ] Period comparison (this month vs last month)
- [ ] Cost alerts/threshold configuration
- [ ] Performance metrics (latency per model, TTFT distributions)

## Acceptance Criteria

- [ ] Usage page accessible at `/usage`
- [ ] Summary cards show requests, tokens, cost, cache rate
- [ ] Time series chart with metric toggle
- [ ] Provider breakdown visualization
- [ ] Model breakdown table with sorting
- [ ] Date range picker with presets + custom
- [ ] Provider/model filters
- [ ] Mobile responsive layout
- [ ] Loading states and error handling
