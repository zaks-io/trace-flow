# Next.js + OpenNext Frontend

## Decision

The Trace Flow web dashboard uses Next.js (App Router) deployed to Cloudflare Workers via `@opennextjs/cloudflare`.

## Why Next.js

- **App Router and RSC**: Server Components reduce client-side JavaScript for pages that don't need interactivity. The dashboard benefits from server-rendered layouts with client-interactive panels.
- **Auth0 SDK support**: `@auth0/nextjs-auth0` provides first-class Next.js integration with middleware-based route protection, server-side session management, and API route handlers.
- **Ecosystem**: Largest React framework ecosystem. Shadcn, TanStack Query, and most React libraries assume Next.js compatibility.
- **File-based routing**: Convention-based routing with layouts, loading states, and error boundaries reduces boilerplate.

## Why OpenNext for Cloudflare

Next.js is optimized for Vercel. Running it on Cloudflare Workers requires an adapter. `@opennextjs/cloudflare` compiles a Next.js app into a Cloudflare Worker:

- **No Vercel lock-in**: Deploy Next.js to any Cloudflare account without vendor dependency.
- **Worker-native**: The build output is a standard Cloudflare Worker with an assets binding for static files.
- **Same deployment pattern**: Uses `wrangler.jsonc` and `--env development` / `--env production` like all other workers in the monorepo.

## Build and Deploy

```bash
# Build Next.js, then compile for Cloudflare
bunx turbo run build --filter=@trace-flow/web
cd apps/web && bunx opennextjs-cloudflare build

# Deploy
cd apps/web && bunx opennextjs-cloudflare deploy --env production
```

The OpenNext build reads the Next.js `.next` output and produces a `.open-next` directory containing the Worker entry point and static assets.
