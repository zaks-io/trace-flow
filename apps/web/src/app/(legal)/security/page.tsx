import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '../components';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How Trace Flow protects your data — AES-256-GCM encryption at rest, PII redaction before storage, tenant-scoped keys, and body-storage opt-out.',
};

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline"
    >
      {children}
    </a>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
      {children}
    </code>
  );
}

export default function SecurityPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary/70">
          Legal &middot; Security
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Security</h1>
        <p className="font-mono text-[11px] text-muted-foreground/50">Effective May 11, 2026</p>
      </header>

      <div className="space-y-8">
        <Section number={1} title="Overview">
          <p>
            Trace Flow proxies LLM API traffic, which means we sit on the path of some of the most
            sensitive content your application handles: prompts, completions, tool calls, and
            structured outputs. This page describes the security controls we apply to that data and
            where your responsibilities begin. It is not legal language; for that, see our{' '}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
          <p>
            You remain responsible for what you send through the proxy. The controls below reduce
            blast radius and stop common categories of sensitive data from being persisted, but they
            are not a substitute for treating prompt content as sensitive in your own systems.
          </p>
        </Section>

        <Section number={2} title="Encryption at rest">
          <p>
            Request and response bodies stored in Cloudflare R2 are encrypted with{' '}
            <strong className="font-medium text-foreground">AES-256-GCM</strong>. Each organization
            gets a distinct encryption key derived with{' '}
            <strong className="font-medium text-foreground">HKDF-SHA-256</strong> from a root key
            held only in Cloudflare Worker secrets. The root key is never exposed to the dashboard,
            the database, or any logging surface.
          </p>
          <p>
            Each ciphertext is bound to its owning organization and storage location: a body cannot
            be decrypted outside the context it was written in. Keys can be rotated without
            re-encrypting existing data.
          </p>
        </Section>

        <Section number={3} title="Encryption in transit">
          <p>
            Every proxy, API, and dashboard route is served over HTTPS with TLS terminated at the
            Cloudflare edge. There is no plaintext fallback. Traffic between our workers and
            downstream providers (OpenAI, Anthropic, Google, Groq, OpenRouter) is also HTTPS.
          </p>
        </Section>

        <Section number={4} title="PII redaction before storage">
          <p>
            Before bodies are written to R2 or enqueued for the OTel pipeline, the proxy runs
            pattern-based redaction over the persisted copy. The client&apos;s response stream is{' '}
            <strong className="font-medium text-foreground">not</strong> modified — your application
            receives the original, unredacted response. Redaction only affects what we keep.
          </p>
          <p>The current ruleset targets common categories of sensitive data, including:</p>
          <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/30">
            <li>Email addresses and phone numbers</li>
            <li>Government identifiers and financial account numbers</li>
            <li>IP addresses</li>
            <li>Bearer tokens and credential-like fields in structured payloads</li>
          </ul>
          <p>
            Redaction applies to request bodies, response bodies, streaming message data, structured
            input messages, response metadata, and error payloads. Pattern matching is best-effort
            and is not a substitute for keeping sensitive data out of prompts where possible — use
            the body-storage opt-out below for requests you know contain regulated content.
          </p>
        </Section>

        <Section number={5} title="Opting out of body storage">
          <p>
            For requests that you know contain sensitive content, set the header{' '}
            <Code>X-Trace-Flow-Omit-Body: true</Code>. The proxy will skip R2 storage entirely for
            that request. Usage metadata (model, token counts, latency, cost, provider) is still
            recorded so dashboards and billing continue to work, but no request or response content
            is persisted.
          </p>
        </Section>

        <Section number={6} title="Tenant isolation">
          <p>Data is scoped to the owning organization at every layer:</p>
          <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/30">
            <li>
              R2 encryption keys are derived per-organization. A ciphertext from one org cannot be
              decrypted under another.
            </li>
            <li>
              Convex queries and mutations enforce organization membership before returning or
              mutating data.
            </li>
            <li>
              Tinybird queries from the dashboard use short-lived (10-minute) JWTs signed by Convex,
              scoped per user with <Code>fixed_params.api_keys</Code> so a user only sees their own
              API keys&apos; traffic. The Tinybird admin token never leaves the Convex environment.
            </li>
          </ul>
        </Section>

        <Section number={7} title="Authentication">
          <p>
            User identity is handled by{' '}
            <strong className="font-medium text-foreground">Auth0</strong>. Sessions are managed
            through the Auth0 Next.js SDK and Convex enforces an authenticated identity on protected
            queries and mutations.
          </p>
          <p>
            Proxy ingest is authenticated with opaque API keys passed in the{' '}
            <Code>X-Trace-Flow-Api-Key</Code> header. Keys are scoped to a single organization and
            are revocable from the dashboard.
          </p>
          <p>
            The <Code>X-Trace-Flow-Api-Key</Code> header is stripped from the request before it is
            forwarded upstream. Your provider API keys (<Code>Authorization</Code>,{' '}
            <Code>x-api-key</Code>) pass through to authenticate with the upstream LLM provider and
            are not stored.
          </p>
        </Section>

        <Section number={8} title="Data retention">
          <p>
            Body retention is tier-based: Hobby and Pro plans have different access windows. When
            the API worker is asked for a body that falls outside the caller&apos;s current
            retention window, it returns HTTP 410 with{' '}
            <Code>Bodies expired under current retention policy</Code>, regardless of whether the
            underlying R2 object is still present.
          </p>
          <p>
            Account deletion windows and your rights to export or delete data are documented in the{' '}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </Section>

        <Section number={9} title="Sub-processors">
          <p>
            We rely on the following providers to operate the Service. Each handles a distinct slice
            of your data.
          </p>
          <ul className="list-none space-y-1.5 pl-0 text-[13px]">
            {(
              [
                [
                  'Cloudflare',
                  'Workers runtime, R2 (encrypted body storage), KV, Queues',
                  'https://www.cloudflare.com/trust-hub/',
                ],
                [
                  'Tinybird',
                  'Usage analytics and trace metrics (ClickHouse)',
                  'https://www.tinybird.co/security',
                ],
                [
                  'Convex',
                  'Application database, auth integration, JWT signing',
                  'https://www.convex.dev/security',
                ],
                [
                  'Auth0',
                  'User authentication and session management',
                  'https://auth0.com/security',
                ],
                [
                  'Sentry',
                  'Error tracking (may include redacted request metadata)',
                  'https://sentry.io/security/',
                ],
              ] as const
            ).map(([name, desc, url]) => (
              <li key={name} className="flex items-baseline gap-2">
                <span className="shrink-0 font-medium text-foreground">{name}</span>
                <span className="text-muted-foreground/30">&mdash;</span>
                <span>{desc}.</span>
                <ExternalLink href={url}>Trust</ExternalLink>
              </li>
            ))}
          </ul>
        </Section>

        <Section number={10} title="Reporting a vulnerability">
          <p>
            If you believe you have found a security issue in Trace Flow, please email{' '}
            <a href="mailto:security@trace-flow.dev" className="text-primary hover:underline">
              security@trace-flow.dev
            </a>{' '}
            with a description, reproduction steps, and any relevant request IDs. We&apos;ll
            acknowledge receipt, investigate, and keep you informed as we work toward a fix. Please
            do not publicly disclose the issue until we have had a reasonable opportunity to address
            it.
          </p>
        </Section>
      </div>
    </div>
  );
}
