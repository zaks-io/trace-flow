# Web Dashboard

The Web Dashboard is a React single-page application that provides observability into LLM requests. It displays trace analytics, request details, and allows management of API keys, alerts, and pricing.

## Tech Stack

- **Vite**: Build tool and dev server
- **React**: UI framework with React Router for navigation
- **Shadcn/ui**: Component library built on Radix primitives
- **Tailwind CSS**: Utility-first styling
- **TanStack Query**: Data fetching and caching
- **Convex**: Real-time backend for user data
- **Auth0**: Authentication provider

## Pages

### Dashboard (`/app`)

Overview of LLM request analytics with summary cards showing:

- Total requests and traces
- Average TTFT and duration
- Error rate
- Total token usage

Includes breakdowns by model and provider with visual bars.

### Requests (`/app/requests`)

Detailed table of individual LLM requests with columns for:

- Trace ID and request ID
- Provider and model
- Status code
- Duration and TTFT
- Token counts
- Cost

Supports filtering, sorting, and column visibility toggling.

### Traces (`/app/traces`)

Aggregated view of traces grouped by trace ID. Shows:

- Total spans per trace
- Duration across all spans
- Aggregated token usage

Useful for viewing multi-request agent workflows.

### Trace Detail (`/app/trace/:traceId`)

Deep dive into a single trace showing:

- Span hierarchy as a tree
- Gantt chart visualization of timing
- Input/output events per span
- Request/response body viewer
- Cost breakdown

### API Keys (`/app/api-keys`)

Management interface for API keys:

- Create new keys with expiration dates
- View existing keys with masked display
- Delete keys
- Sync keys to Cloudflare KV

### Pricing (`/app/pricing`)

Model pricing configuration:

- View all stored model prices
- Add/edit manual pricing entries
- Import pricing from OpenRouter
- Sync default pricing to KV

### Alerts (`/app/alerts`)

Alert rule management:

- Create rules based on fields (duration, tokens, cost, errors)
- Configure thresholds and operators
- Set severity levels (info, warning, error)
- Enable/disable individual alerts

## Data Fetching

### Tinybird Pipe Hook

The `useTinybirdPipe` hook fetches data from Tinybird's Pipe API:

1. Requests a scoped JWT from Convex action
2. Calls Tinybird Pipe endpoint with JWT
3. Auto-refreshes token on 403 (expiry)
4. Supports polling for live updates

Token scopes include the user's API keys as fixed_params, ensuring row-level security.

### Live Mode

Several pages support live mode polling:

- Requests table polls every 10 seconds
- Trace detail polls for new spans
- Dashboard can refresh on demand

Polling stops on error to prevent retry loops.

### Body Fetching

Request and response bodies are fetched from the API worker using Auth0 tokens:

1. Get Auth0 access token from hook
2. Call API worker endpoint with Bearer token
3. Parse JSON body for display

## Convex Integration

The dashboard uses Convex for real-time backend services:

**Queries**:

- `users.getCurrentUserQuery`: Get current user info
- `apiKeys.list`: List user's API keys
- `alerts.list`: List user's alerts
- `modelPricing.list`: List all pricing entries

**Mutations**:

- `apiKeys.create/update/remove`: Manage API keys
- `alerts.create/update/toggle/remove`: Manage alerts
- `modelPricing.upsert/remove`: Manage pricing

**Actions**:

- `tinybird.generateToken`: Generate scoped Tinybird JWT
- `apiKeys.syncToKV`: Sync key to Cloudflare KV
- `modelPricing.importFromOpenRouter`: Bulk import pricing

## Authentication Flow

1. User visits any `/app/*` route
2. Auth0Provider checks for valid session
3. If no session, redirects to Auth0 login
4. On success, Auth0 redirects back with tokens
5. ConvexProviderWithAuth0 exchanges token for Convex auth
6. useInitializeUser hook creates/updates user record

Tokens are stored in localStorage with refresh token support.

## Component Architecture

**Layout Components**:

- `AppLayout`: Main layout with sidebar
- `AppSidebar`: Navigation with collapsible sections
- `PageHeader`: Consistent page headers with breadcrumbs

**Data Components**:

- `RequestsTable`: TanStack Table with sorting/filtering
- `SpanGanttChart`: Horizontal timeline of spans
- `AgentGanttChart`: Grouped spans by trace
- `TraceDetailPanel`: Expandable span details

**UI Components**:

- Shadcn primitives: Button, Input, Dialog, Sheet
- Custom: SummaryCard, AlertBadge, TokenSummaryCards

## Environment Variables

| Variable                       | Purpose                          |
| ------------------------------ | -------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`       | Convex deployment URL            |
| `NEXT_PUBLIC_AUTH0_DOMAIN`     | Auth0 tenant domain              |
| `NEXT_PUBLIC_AUTH0_CLIENT_ID`  | Auth0 application ID             |
| `NEXT_PUBLIC_API_URL`          | API worker URL for body fetching |
| `NEXT_PUBLIC_TINYBIRD_API_URL` | Tinybird API endpoint            |

## Key Files

- `workers/web/src/components/App.tsx` - Root app with providers
- `workers/web/src/components/routes.tsx` - Route definitions
- `workers/web/src/hooks/useTinybirdPipe.ts` - Tinybird data hook
- `workers/web/src/components/pages/` - Page components
- `workers/web/src/components/ui/` - Shadcn components
