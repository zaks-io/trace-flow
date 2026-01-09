# Astro Frontend: Static-First Dashboard

## Decision

The Trace Flow web dashboard uses Astro as its framework, with React components hydrated selectively for interactive features. Static pages (landing, documentation) ship zero JavaScript by default.

## Context

The dashboard serves two distinct purposes:

1. **Marketing/docs pages**: Landing page, documentation, pricing
2. **Application**: Interactive dashboard with real-time data, filters, charts

These have opposite requirements. Marketing pages need fast initial load and SEO. The application needs rich interactivity and state management.

A single-framework approach forces compromise. Next.js optimizes for React everywhere, adding JavaScript overhead to static pages. Pure static site generators lack the interactivity needed for the dashboard.

## Alternatives Considered

### Next.js

Next.js was the default consideration given its popularity and React ecosystem.

**App Router complexity.** The App Router introduced Server Components, Server Actions, and a new mental model. For a dashboard that's primarily client-side (authentication, real-time updates, user interactions), this adds complexity without benefit.

**JavaScript everywhere.** Even static pages include the Next.js runtime. The landing page would ship React and framework code regardless of interactivity needs.

**Cloudflare Pages friction.** While Next.js supports edge deployment, it's optimized for Vercel. Cloudflare Pages integration requires the `@cloudflare/next-on-pages` adapter with ongoing compatibility considerations.

**Bundle size.** Next.js apps typically start at 80-100KB of JavaScript before application code. For pages that need no interactivity, this is pure overhead.

### Plain React (Vite)

A Vite-based React SPA was considered for simplicity.

**No static rendering.** SPAs require JavaScript to render anything. The landing page would show a blank screen until React loads and executes.

**SEO limitations.** Search engines can execute JavaScript but prefer pre-rendered content. Marketing pages need to be crawlable.

**Single bundle.** The entire application loads upfront. Users visiting the landing page download dashboard code they may never use.

### Remix

Remix focuses on server-rendered React with progressive enhancement.

**Overcomplicated for our use case.** Remix's loader/action patterns are powerful but unnecessary when the application is primarily client-side with direct API calls to Tinybird and Convex.

**Cloudflare support.** Remix has good Cloudflare Workers support, but the framework's complexity doesn't pay off for our architecture where the frontend is a thin client over backend APIs.

## Why Astro

### Zero JavaScript by Default

Astro pages ship no JavaScript unless explicitly added:

```astro
---
// This is server-side only
import BaseLayout from '@/layouts/BaseLayout.astro';
---

<BaseLayout title="Trace Flow">
  <h1>See Every Request</h1>
  <p>Pure HTML, zero JavaScript</p>
</BaseLayout>
```

The landing page loads in under 50KB total (HTML, CSS, images). No framework runtime, no React, no hydration.

### Islands Architecture

Interactive components are isolated "islands" that hydrate independently:

```astro
---
import { App } from '@/components/App';
---

<BaseLayout title="Dashboard">
  <App client:only="react" />
</BaseLayout>
```

The `client:only="react"` directive means:

- This component renders only on the client
- React loads only for pages using React islands
- Other pages remain JavaScript-free

For the dashboard, the entire `<App>` component is a React island that takes over after initial load.

### Multiple Frameworks Supported

Astro supports React, Vue, Svelte, and Solid in the same project. We use React for the dashboard but could add Vue documentation components or Svelte widgets without framework conflicts.

In practice, we use:

- **Astro components**: Landing page, layouts, documentation
- **React components**: Dashboard application, interactive UI

### Native Cloudflare Pages Integration

Astro's `@astrojs/cloudflare` adapter provides first-class Pages support:

```javascript
// astro.config.mjs
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  adapter: cloudflare({
    mode: 'directory',
    platformProxy: { enabled: true },
  }),
});
```

The adapter:

- Generates Pages-compatible output
- Enables platform bindings access
- Supports edge rendering when needed
- Works with `wrangler pages dev` locally

### Content Collections (Unused but Available)

Astro's content collections provide type-safe Markdown/MDX handling. While we currently use `.astro` files for documentation, content collections enable:

- Markdown-based docs with frontmatter validation
- Automatic table of contents generation
- Related content linking

This is infrastructure for future documentation expansion.

## How React is Used Within Astro

### The Dashboard Island

The authenticated dashboard is a single React application:

```astro
<!-- /src/pages/app/[...slug].astro -->
---
import BaseLayout from '@/layouts/BaseLayout.astro';
import { App } from '@/components/App';
---

<BaseLayout title="Trace Flow">
  <App client:only="react" />
</BaseLayout>
```

The `[...slug].astro` catch-all route handles all `/app/*` paths. React Router takes over client-side routing within the app.

### Why client:only vs client:load

Astro offers several hydration strategies:

- `client:load`: Hydrate immediately on page load
- `client:idle`: Hydrate when browser is idle
- `client:visible`: Hydrate when component enters viewport
- `client:only`: Render only on client, skip SSR

We use `client:only="react"` because:

1. **Auth0 requires browser**: Authentication uses browser APIs
2. **Convex needs client state**: Real-time subscriptions are client-side
3. **No SSR benefit**: The dashboard is behind authentication, so SSR adds no SEO value

The entire dashboard is a client-rendered SPA within the Astro shell.

### React Component Structure

Within the React island, we use standard patterns:

```typescript
// App.tsx
export function App() {
  return (
    <BrowserRouter basename="/app">
      <Auth0Provider>
        <ConvexProviderWithAuth0>
          <QueryClientProvider>
            <AppRoutes />
          </QueryClientProvider>
        </ConvexProviderWithAuth0>
      </Auth0Provider>
    </BrowserRouter>
  );
}
```

React Router, Auth0, Convex, and TanStack Query work normally. The Astro boundary is transparent to the React application.

## Static Pages

### Landing Page

The landing page is pure Astro:

```astro
---
import BaseLayout from '@/layouts/BaseLayout.astro';
import FlowingTraces from '@/components/landing/FlowingTraces.astro';
---

<BaseLayout title="Trace Flow - LLM Analytics">
  <div class="hero">
    <h1>See Every Request</h1>
    <FlowingTraces />
    <a href="/app">Sign In</a>
  </div>
</BaseLayout>
```

- No React, no framework JavaScript
- CSS animations for visual interest
- Fast initial paint (<100ms)
- Perfect Lighthouse scores

### Documentation Pages

Documentation uses Astro components with Shiki for syntax highlighting:

```astro
---
import DocsLayout from '@/layouts/DocsLayout.astro';
import CodeBlock from '@/components/docs/CodeBlock.astro';
---

<DocsLayout title="Quick Start">
  <h1>Quick Start Guide</h1>

  <CodeBlock lang="bash">
    curl -X POST https://gateway.trace-flow.dev/openai/v1/chat/completions
  </CodeBlock>
</DocsLayout>
```

Syntax highlighting happens at build time, not runtime. No JavaScript required for code blocks.

## Trade-offs

### Smaller Ecosystem

Astro's ecosystem is smaller than Next.js:

- Fewer pre-built integrations
- Less Stack Overflow coverage
- Smaller community for edge cases

For our use case, the ecosystem coverage is sufficient. React components work normally, and we don't need complex SSR patterns.

### Different Mental Model

Developers familiar with Next.js need to understand:

- Component files don't equal pages (`.astro` vs `.tsx`)
- Hydration directives control JavaScript loading
- Server/client boundary is explicit, not implicit

This learning curve is real but manageable. The mental model is arguably simpler than Next.js App Router.

### No Incremental Static Regeneration

Astro doesn't have Next.js-style ISR. Pages are either:

- Fully static (built at deploy time)
- Fully dynamic (rendered per-request)

For our use case, this isn't limiting. Marketing pages are static, and the dashboard is client-rendered. We don't need hybrid patterns.

### React 19 Compatibility Workarounds

React 19 with Cloudflare Workers required a Vite alias:

```javascript
// astro.config.mjs
vite: {
  resolve: {
    alias: {
      ...(process.env.NODE_ENV === 'production' && {
        'react-dom/server': 'react-dom/server.edge',
      }),
    },
  },
}
```

The `.browser` version uses `MessageChannel` which isn't available in workerd. This is the type of edge case that smaller ecosystems surface.

## Outcome

Astro provides:

- **Zero-JS landing page**: <50KB total, instant load
- **Full React dashboard**: Standard patterns, no compromises
- **Clear boundaries**: Static vs interactive is explicit
- **Cloudflare native**: First-class Pages deployment

The islands architecture matches how users interact with Trace Flow: browse marketing pages quickly, then enter an interactive application. Each mode gets optimized treatment without forcing the other to compromise.
