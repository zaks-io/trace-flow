# LLM Usage & Cost Reporting Page

## Overview

A cost analytics deep-dive page at `/app/usage`, distinct from the Dashboard overview. Surfaces the full 5-way cost breakdown (input, output, cache read, cache creation, reasoning), per-operation segmentation, and model efficiency metrics from existing Tinybird rollup tables.

## Tinybird Endpoints

| Endpoint                 | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `llm_usage_summary`      | Totals + 5-way cost breakdown for a range                 |
| `llm_usage_timeseries`   | Per-bucket cost breakdown for stacked area charts         |
| `llm_usage_by_model`     | Model breakdown with cost efficiency ($/1K output tokens) |
| `llm_usage_by_provider`  | Provider breakdown with cost columns                      |
| `llm_usage_by_operation` | BaggageOperation grouping with cost/request/token totals  |

All pipes return cost values already converted to USD (divided by 1,000,000 in the pipe).

### Pipe Changes (from baseline)

All pipes were updated to SELECT the individual cost columns (`InputCostMicrodollars`, `OutputCostMicrodollars`, `CacheReadCostMicrodollars`, `CacheCreationCostMicrodollars`, `ReasoningCostMicrodollars`) that already exist in the `llm_usage_1h/1d/1mo` rollup tables. No schema migrations required.

- **`llm_usage_by_model`** also adds `cost_per_1k_output_tokens` computed column
- **`llm_usage_by_operation`** is a new pipe grouping by `BaggageOperation`

## Page Design

### Route

`/app/usage` — Added to sidebar navigation between Dashboard and Requests.

### Layout

```
+---------------------------------------------------------------+
| Usage & Costs                      [7d] [30d] [90d]           |
|                         [Provider v] [Model v] [Operation v]  |
+---------------------------------------------------------------+
| +----------+ +----------+ +----------+ +----------+           |
| | Requests | | Cost     | | Cache $  | | Cost/Req |           |
| | 12,345   | | $245.67  | | $42 (17%)| | $0.019   |           |
| +----------+ +----------+ +----------+ +----------+           |
+---------------------------------------------------------------+
|                                                                |
|  Cost Over Time (Stacked Area — Recharts)                     |
|  [Cost] [Tokens] [Requests]  metric toggle                    |
|  Stacked areas: input | output | cache | reasoning            |
|                                                                |
+---------------------------------------------------------------+
| +---------------------------+ +------------------------------+ |
| | Cost Breakdown (Donut)   | | By Operation (Table)          | |
| |  Input       $120 (49%) | | Operation    Reqs    Cost     | |
| |  Output      $80  (33%) | | summarize    3.2k   $89.20   | |
| |  Cache Read  $5   (2%)  | | code-review  1.8k   $62.10   | |
| |  Cache Write $15  (6%)  | | chat         890    $45.30   | |
| |  Reasoning   $25  (10%) | |                               | |
| +---------------------------+ +------------------------------+ |
+---------------------------------------------------------------+
| Model Comparison (Sortable Table — full width)                 |
| Model     | Reqs  | Cost    | $/1K out | Cache% | Reasoning% |
| gpt-4o    | 5.2k  | $132.10 | $0.042   | 23%    | -          |
| claude-3.5| 2.1k  | $62.50  | $0.031   | 45%    | -          |
| o1-mini   | 890   | $28.40  | $0.089   | -      | 34%        |
+---------------------------------------------------------------+
| Provider Breakdown (Horizontal bar chart)                      |
+---------------------------------------------------------------+
```

## Components

| Component                | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `SummaryCard`            | Reusable metric card (requests, cost, cache, $/req)            |
| `CostTimeseriesChart`    | Recharts `<AreaChart>` with stacked cost areas + metric toggle |
| `CostBreakdownChart`     | Recharts `<PieChart>` donut with cost category legend          |
| `OperationTable`         | Table by `baggage_operation` with requests + cost              |
| `ModelComparisonTable`   | Sortable table: model, reqs, cost, $/1K, cache%, reasoning%    |
| `ProviderBreakdownChart` | Recharts `<BarChart>` horizontal bars by provider              |
| `FilterDropdown`         | Reusable dropdown for provider/model/operation filters         |

All components are defined in `apps/web/src/components/pages/Usage.tsx`.

### Shared Utilities

`formatNumber`, `formatCurrency`, `formatPercent` extracted to `apps/web/src/lib/format.ts` and imported by both Dashboard and Usage pages.

## Files

| File                                          | Change                                           |
| --------------------------------------------- | ------------------------------------------------ |
| `pipes/llm_usage_summary.pipe`                | Add 5 cost breakdown columns                     |
| `pipes/llm_usage_timeseries.pipe`             | Add 5 cost breakdown columns                     |
| `pipes/llm_usage_by_model.pipe`               | Add cost breakdown + `cost_per_1k_output_tokens` |
| `pipes/llm_usage_by_provider.pipe`            | Add 5 cost breakdown columns                     |
| `pipes/llm_usage_by_operation.pipe`           | **New** — group by BaggageOperation              |
| `apps/web/src/components/pages/Usage.tsx`     | **New** — Usage page + all sub-components        |
| `apps/web/src/app/app/usage/page.tsx`         | **New** — Next.js route                          |
| `apps/web/src/lib/format.ts`                  | **New** — extracted format utils                 |
| `apps/web/src/components/pages/Dashboard.tsx` | Import from shared format utils                  |
| `apps/web/src/components/AppSidebar.tsx`      | Add Usage nav entry                              |
| `apps/web/package.json`                       | Add recharts dependency                          |

## Deferred (Separate Tickets)

- Latency metrics in rollups (requires schema migration)
- Period-over-period comparison UI
- Budget/spend alerts
- CSV export

## Acceptance Criteria

- [ ] Usage page accessible at `/app/usage` via sidebar navigation
- [ ] 4 summary cards: Requests, Total Cost, Cache Savings (with % of total), Cost/Request
- [ ] Stacked area chart with cost breakdown by category (input/output/cache/reasoning)
- [ ] Metric toggle between Cost, Tokens, and Requests views
- [ ] Donut chart showing cost category proportions
- [ ] Operation table grouped by `baggage_operation`
- [ ] Model comparison table with sortable columns (reqs, cost, $/1K output)
- [ ] Provider horizontal bar chart
- [ ] Filter dropdowns for provider, model, and operation
- [ ] Time range selector (7d, 30d, 90d)
- [ ] Loading states and error handling
- [ ] Dashboard page still works (format utils extraction only)
- [ ] `bun run type-check && bun run lint && bun run build` pass
