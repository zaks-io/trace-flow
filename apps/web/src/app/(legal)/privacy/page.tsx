import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '../components';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Privacy Policy for Trace Flow: how we collect, use, and protect your data.',
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

export default function PrivacyPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary/70">
          Legal &middot; Privacy
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Privacy Policy
        </h1>
        <p className="font-mono text-[11px] text-muted-foreground/50">
          Effective September 4, 2026
        </p>
      </header>

      <div className="space-y-8">
        <Section number={1} title="Who We Are">
          <p>
            Trace Flow is operated by Zaks.io LLC, a California limited liability company. For
            privacy inquiries, contact{' '}
            <a href="mailto:privacy@zaks.io" className="text-primary hover:underline">
              privacy@zaks.io
            </a>
            .
          </p>
        </Section>

        <Section number={2} title="What Data We Collect">
          <p>When you use the Service, we collect:</p>
          <dl className="space-y-3">
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">Request and response content</dt>
              <dd className="mt-1 text-[13px]">
                When recording is enabled, Trace Flow stores the prompt text, system instructions,
                tool calls, and model completions from LLM API calls routed through the proxy. You
                can opt out of body storage for a request by setting the{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                  X-Trace-Flow-Omit-Body: true
                </code>{' '}
                header. Usage metadata is still recorded, but the request and response bodies are
                omitted.
              </dd>
            </div>
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">Usage metadata</dt>
              <dd className="mt-1 text-[13px]">
                Model name, token counts (input/output), latency, estimated cost, provider name, and
                timestamps.
              </dd>
            </div>
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">Coding-agent analytics</dt>
              <dd className="mt-1 text-[13px]">
                If you enable collector syncing, the local collector reads supported coding-agent
                stores and uploads typed facts such as source, model, token usage, tool outcomes,
                repository fingerprints, and redacted excerpts. The normal analytics path does not
                upload raw transcripts. Conversation Archive is separate and is not currently
                available.
              </dd>
            </div>
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">Account data</dt>
              <dd className="mt-1 text-[13px]">
                Email address, name, account identifiers, organization membership, subscription
                state, and authentication metadata managed through Auth0.
              </dd>
            </div>
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">API keys in transit</dt>
              <dd className="mt-1 text-[13px]">
                Your LLM provider credentials pass through the gateway to authenticate with the
                upstream provider. Trace Flow does not write those header values to its application
                database, analytics tables, or stored request and response bodies.
              </dd>
            </div>
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">Website telemetry</dt>
              <dd className="mt-1 text-[13px]">
                The website sends performance traces, errors, and sampled session replays to Sentry.
                Replay configuration masks text and form inputs and blocks media. LaunchDarkly may
                receive account identity and subscription attributes when feature flags are enabled.
              </dd>
            </div>
          </dl>
        </Section>

        <Section number={3} title="How We Use Your Data">
          <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/30">
            <li>Display request analytics and cost breakdowns in dashboards</li>
            <li>Generate usage reports and trend analysis</li>
            <li>Provide trace-level debugging for individual LLM calls</li>
            <li>Provide coding-agent cost, context, tool, repository, and review analytics</li>
            <li>Authenticate your identity and secure your account</li>
          </ul>
          <p>
            We do <strong className="font-medium text-foreground">not</strong> use your data for
            advertising, model training, profiling, or any purpose beyond operating the Service.
          </p>
        </Section>

        <Section number={4} title="Data Storage and Security">
          <p>Your data is stored across the following infrastructure providers:</p>
          <dl className="space-y-2 text-[13px]">
            {(
              [
                ['Cloudflare R2', 'Request and response body storage'],
                ['Tinybird (ClickHouse)', 'Usage analytics and metrics'],
                ['Convex Cloud', 'Application backend and metadata'],
                ['Auth0', 'Authentication'],
                ['Sentry', 'Performance monitoring, error tracking, and masked session replay'],
                ['LaunchDarkly', 'Feature flags and product rollout targeting'],
              ] as const
            ).map(([name, desc]) => (
              <div key={name} className="flex items-baseline gap-2">
                <dt className="shrink-0 font-medium text-foreground">{name}</dt>
                <span className="h-px min-w-4 flex-1 bg-border/50" />
                <dd className="shrink-0">{desc}</dd>
              </div>
            ))}
          </dl>
          <p>
            All data is scoped to your organization. One organization cannot access another&apos;s
            data. We use HTTPS for all data in transit, and request and response bodies stored in R2
            are encrypted at rest with per-organization AES-256-GCM keys. See our{' '}
            <Link href="/security" className="text-primary hover:underline">
              Security page
            </Link>{' '}
            for details on encryption, PII redaction, and tenant isolation.
          </p>
        </Section>

        <Section number={5} title="Data Sharing">
          <p>
            We do not sell or rent personal data. We disclose data to the infrastructure and service
            providers listed here only as needed to operate Trace Flow.
          </p>
        </Section>

        <Section number={6} title="Data Retention">
          <p>
            Model trace access is limited to 7 days on Hobby and 30 days on Pro. Aggregate model
            usage tables have longer operational retention: hourly rows for 90 days, daily rows for
            2 years, and monthly rows for 5 years. Coding-agent facts and aggregates expire after 1
            year. An access limit does not guarantee that an underlying encrypted body object has
            already been physically removed.
          </p>
          <p>
            Account and control-plane data is retained while an account is active and as needed to
            operate the Service. You may request access or deletion by contacting us. Requests are
            handled according to applicable law and may require identity verification.
          </p>
        </Section>

        <Section number={7} title="Your Rights">
          <p>Depending on your jurisdiction, you may have the right to:</p>
          <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/30">
            <li>Access the personal data we hold about you</li>
            <li>Request correction of inaccurate data</li>
            <li>Request deletion of your data</li>
            <li>Export your data in a portable format</li>
            <li>Object to or restrict processing of your data</li>
          </ul>
          <p>
            California residents have additional rights under the CCPA. European residents have
            additional rights under the GDPR. To exercise any of these rights, contact{' '}
            <a href="mailto:privacy@zaks.io" className="text-primary hover:underline">
              privacy@zaks.io
            </a>
            .
          </p>
        </Section>

        <Section number={8} title="Cookies and Tracking">
          <p>
            The Service uses session cookies for authentication through Auth0. We do not use
            advertising trackers or sell behavioral data. Sentry collects performance telemetry and
            sampled, masked session replays. When feature flags are enabled, LaunchDarkly may
            receive account identity attributes needed to evaluate and audit product rollouts.
          </p>
        </Section>

        <Section number={9} title="Sensitive Data">
          <p>
            LLM prompts, responses, and coding-agent excerpts may contain personally identifiable
            information, proprietary code, trade secrets, or other sensitive content. You are
            responsible for the data you route through the gateway or choose to sync. Trace Flow
            processes this content to redact persisted copies, extract observability metadata, and
            provide the Service. We do not use customer content for advertising or model training.
          </p>
        </Section>

        <Section number={10} title="Third-Party Services">
          <ul className="list-none space-y-1.5 pl-0 text-[13px]">
            {(
              [
                ['Auth0 (Okta)', 'Authentication', 'https://auth0.com/privacy'],
                [
                  'Convex',
                  'Database and backend',
                  'https://www.convex.dev/legal/privacy/v2024-03-21',
                ],
                [
                  'Cloudflare',
                  'Edge network and storage',
                  'https://www.cloudflare.com/privacypolicy/',
                ],
                ['Tinybird', 'Analytics', 'https://www.tinybird.co/privacy'],
                [
                  'Sentry',
                  'Performance monitoring, error tracking, and masked session replay',
                  'https://sentry.io/privacy/',
                ],
                [
                  'LaunchDarkly',
                  'Feature flags and rollout targeting',
                  'https://launchdarkly.com/policies/privacy/',
                ],
              ] as const
            ).map(([name, desc, url]) => (
              <li key={name} className="flex items-baseline gap-2">
                <span className="shrink-0 font-medium text-foreground">{name}</span>
                <span className="text-muted-foreground/30">&mdash;</span>
                <span>{desc}.</span>
                <ExternalLink href={url}>Policy</ExternalLink>
              </li>
            ))}
          </ul>
        </Section>

        <Section number={11} title="Changes to This Policy">
          <p>
            We may update this policy at any time. Material changes will be noted by updating the
            effective date above. Continued use of the Service after changes constitutes acceptance.
          </p>
        </Section>

        <Section number={12} title="Contact">
          <p>
            For privacy-related questions or data requests, contact{' '}
            <a href="mailto:privacy@zaks.io" className="text-primary hover:underline">
              privacy@zaks.io
            </a>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}
