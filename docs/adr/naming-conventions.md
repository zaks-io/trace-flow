# Naming Conventions

Canonical naming patterns across the Trace Flow codebase. Follow these conventions for all new code.

## File Names

| Context                     | Convention                  | Examples                                                         |
| --------------------------- | --------------------------- | ---------------------------------------------------------------- |
| Worker/package source files | camelCase                   | `apiKeys.ts`, `defaultPricing.ts`, `usageTracker.ts`             |
| Multi-word worker source    | kebab-case                  | `request-body.ts`, `metadata-regex.ts`, `openrouter-pricing.ts`  |
| React components            | PascalCase                  | `AppSidebar.tsx`, `TokenSummaryCards.tsx`, `SpanDetailPanel.tsx` |
| shadcn/ui components        | kebab-case                  | `dropdown-menu.tsx`, `data-table.tsx`, `table-toolbar.tsx`       |
| React hooks                 | camelCase with `use` prefix | `useApiKeyMap.ts`, `useTinybirdPipe.ts`, `useTableFilters.ts`    |
| Lib utilities               | camelCase or kebab-case     | `cacheMetrics.ts`, `auth-cookies.ts`, `traceToMarkdown.ts`       |
| Tinybird datasources        | snake_case                  | `llm_requests.datasource`, `otel_traces.datasource`              |
| Tinybird pipes              | snake_case                  | `trace_detail.pipe`, `llm_usage_timeseries.pipe`                 |
| Convex modules              | camelCase                   | `apiKeys.ts`, `stripeEvents.ts`, `modelPricing.ts`               |
| Convex migrations           | camelCase                   | `backfillOrgs.ts`, `backfillOrgBilling.ts`                       |
| MCP tool actions            | camelCase                   | `getTraceAction.ts`, `listTracesAction.ts`                       |
| Test files                  | `__tests__/*.test.ts`       | `auth.test.ts`, `pricing.test.ts`, `capture.test.ts`             |
| Config files                | kebab-case or dotfile       | `vitest.config.ts`, `open-next.config.ts`, `eslint.config.js`    |
| Scripts                     | kebab-case                  | `check-tinybird.sh`, `setup-worktree.sh`                         |

### Known Inconsistencies

- **Hooks**: `use-mobile.ts` (shadcn default, kebab-case) vs `useApiKeyMap.ts` (project convention, camelCase). **Prefer camelCase** for new hooks.
- **Lib files**: Mixed — `cacheMetrics.ts` (camelCase) vs `auth-cookies.ts` (kebab-case). Both are acceptable; kebab-case tends to be multi-word utility modules, camelCase for domain modules.
- **Worker source**: Mixed — `usage-tracker.ts` (kebab-case) vs `usageTracker.ts` style. The proxy worker uses kebab-case for parser files (`request-body.ts`, `metadata-regex.ts`) and camelCase for top-level files (`providers.ts`, `storage.ts`). No strong enforcement needed; be consistent within a directory.

## TypeScript Identifiers

| Kind               | Convention                      | Examples                                                              |
| ------------------ | ------------------------------- | --------------------------------------------------------------------- |
| Types / Interfaces | PascalCase                      | `QueueMessage`, `SubscriptionTier`, `TinybirdTrace`, `LLMTokenUsage`  |
| Functions          | camelCase                       | `getCurrentUser`, `parseTraceparent`, `storeRequestResponse`          |
| Constants          | UPPER_SNAKE_CASE                | `TIER_CONFIG`, `RETENTION_DAYS`, `STRIPE_API_VERSION`                 |
| Scoped constants   | camelCase                       | `stripeSecretKey`, `stripeProPriceId` (module-level but not exported) |
| React components   | PascalCase                      | `AppSidebar`, `TokenSummaryCards`, `FilterDropdown`                   |
| React hooks        | camelCase with `use` prefix     | `useIsMobile`, `useTinybirdPipe`, `useConvexAuthSession`              |
| Enum-like objects  | UPPER_SNAKE_CASE for the object | `TIER_CONFIG`, `MCP_SERVER_INFO`, `MCP_SERVER_CAPABILITIES`           |

### Acronyms in Identifiers

- **LLM**, **SSE**, **KV**, **R2** — keep uppercase when leading: `LLMRequest`, `SSEEvent`, `KVData`
- **API**, **URL**, **ID** — uppercase in PascalCase types: `ApiKey` (Tinybird column), but `apiKey` in camelCase variables
- **OTel**, **OTLP** — uppercase prefix: `OTLPQueueMessage`, `otelTraces`
- **MCP** — uppercase prefix: `MCPSessions`, `mcpSessions` (Convex table)

## Convex Patterns

### Table Names

camelCase plural: `users`, `apiKeys`, `stripeEvents`, `organizationMembers`, `mcpSessions`, `addonPurchases`

### Index Names

snake*case with `by*`prefix:`by_org_id`, `by_token_identifier`, `by_stripe_customer_id`, `by_org_id_period`, `by_org_id_status`

### Exported Functions

Named exports matching CRUD-like verbs:

```ts
export const list = query({...});
export const create = mutation({...});
export const update = mutation({...});
export const remove = mutation({...});   // not "delete" (reserved word)
export const getByKey = query({...});
```

Internal functions use `internal` prefix from server:

```ts
export const getByIdInternal = internalQuery({...});
export const listByUserId = internalQuery({...});
export const syncKeyToKV = internalAction({...});
```

### Schema Field Names

camelCase: `orgId`, `stripeCustomerId`, `currentPeriodStart`, `autoTopupPendingSince`

## Storage Key Formats

### KV Keys

| Purpose           | Format        | Example               |
| ----------------- | ------------- | --------------------- |
| API key lookup    | Raw UUID      | `a1b2c3d4-e5f6-...`   |
| Subscription data | `sub:{orgId}` | `sub:j57abc123def456` |

### R2 Keys

| Purpose              | Format               | Example           |
| -------------------- | -------------------- | ----------------- |
| Combined body object | `bodies/{requestId}` | `bodies/a1b2c3d4` |

Tier-based visibility is enforced at read time rather than encoded into the R2 key.

## Tinybird / ClickHouse

### Column Names

PascalCase throughout: `ReceivedAt`, `TraceId`, `SpanId`, `ApiKey`, `StatusCode`, `InputTokens`, `TotalCostMicrodollars`, `TierAtIngestion`, `RetentionExpiresAt`

### Nested Column Names

Dot-separated PascalCase: `Events.Timestamp`, `Events.Name`, `Links.TraceId`

### Datasource File Names

snake_case: `otel_traces.datasource`, `llm_requests.datasource`, `llm_usage_1h.datasource`

### Pipe File Names

snake_case: `trace_detail.pipe`, `llm_usage_timeseries.pipe`, `filter_options.pipe`

## React / Next.js Patterns

### Component Files

- **Custom components**: PascalCase — `AppSidebar.tsx`, `PageHeader.tsx`, `ConvexClientProvider.tsx`
- **shadcn/ui components**: kebab-case — `dropdown-menu.tsx`, `data-table.tsx`
- **Component subdirectories**: kebab-case — `requests-table/`, `spans-table/`, `usage/`
- **Page components in subdirectories**: PascalCase — `usage/ApiKeyBreakdownTable.tsx`, `usage/CostTimeseriesChart.tsx`

### Next.js Route Files

Next.js conventions: `page.tsx`, `layout.tsx`, `error.tsx`, `route.ts`, `middleware.ts`

Route segments use kebab-case: `api-keys/`, `quick-start/`, `sdk-reference/`

Client components in route directories use PascalCase: `AppLayoutClient.tsx`, `AdminInvitesClient.tsx`

### CSS

Tailwind utility classes exclusively. No custom class naming conventions — only `globals.css` with CSS variables for theming (via shadcn). No BEM, no CSS modules.

## Git Conventions

### Branch Names

Loosely typed prefixes, not strictly enforced:

- `feat/` or `feature/` — `feat/github-actions-deploy`
- `fix/` — `fix/deploy-workflow`, `fix/align-prettierignore-with-gitignore`
- `refactor/` — `refactor/react-best-practices-audit`, `refactor/simplify-dev-tooling`
- Some branches use bare descriptive names: `auth`, `preload`, `costs-bugs`, `ui-updates`

### Commit Messages

Conventional commits prefix: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`

## Test File Organization

All test files live in `__tests__/` directories adjacent to source:

```
src/
  __tests__/
    auth.test.ts
    index.test.ts
    parsers/
      errors.test.ts
      providers/
        anthropic.test.ts
  auth.ts
  index.ts
  parsers/
    errors.ts
    providers/
      anthropic.ts
```

Integration tests use `.integration.test.ts` suffix: `batcher.integration.test.ts`, `index.integration.test.ts`

Test directories mirror source structure for deep modules (`__tests__/parsers/providers/` mirrors `parsers/providers/`).
