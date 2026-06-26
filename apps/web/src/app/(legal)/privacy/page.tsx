import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '../components';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Privacy Policy for Trace Flow — how we collect, use, and protect your data.',
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
        <p className="font-mono text-[11px] text-muted-foreground/50">Effective March 9, 2026</p>
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
                Full prompt text, system instructions, tool calls, and model completions from LLM
                API calls routed through the proxy, stored per-organization. You can opt out of body
                storage by setting the{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                  X-Trace-Flow-Omit-Body: true
                </code>{' '}
                header on your requests — metadata and usage metrics are still recorded, but the
                full request and response content will not be stored.
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
              <dt className="text-sm font-medium text-foreground">Account data</dt>
              <dd className="mt-1 text-[13px]">
                Email address, name, and authentication tokens provided during sign-in via Auth0.
              </dd>
            </div>
            <div className="rounded-md border border-border/50 px-4 py-3">
              <dt className="text-sm font-medium text-foreground">API keys in transit</dt>
              <dd className="mt-1 text-[13px]">
                Your LLM provider API keys pass through the proxy to authenticate with upstream
                providers. API keys are{' '}
                <strong className="font-medium text-foreground">not stored</strong> by Trace Flow.
              </dd>
            </div>
          </dl>
        </Section>

        <Section number={3} title="How We Use Your Data">
          <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/30">
            <li>Display request analytics and cost breakdowns in dashboards</li>
            <li>Generate usage reports and trend analysis</li>
            <li>Provide trace-level debugging for individual LLM calls</li>
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
                ['Sentry', 'Error tracking (may include request metadata)'],
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
            We do not sell, rent, or share your personal data with third parties. Data is only
            shared with the infrastructure providers listed above as necessary to operate the
            Service.
          </p>
        </Section>

        <Section number={6} title="Data Retention">
          <p>
            We retain your data for as long as your account is active. You may request deletion of
            your data at any time by contacting us. Upon account termination, data will be deleted
            within 30 days. See our{' '}
            <Link href="/terms" className="text-primary hover:underline">
              Terms of Service
            </Link>{' '}
            for details on account termination.
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
            The Service uses session cookies for authentication (set by Auth0). We do not use
            advertising trackers or sell behavioral data. When feature flags are enabled,
            LaunchDarkly may receive account identity attributes needed to evaluate and audit
            product rollouts.
          </p>
        </Section>

        <Section number={9} title="Sensitive Data">
          <p>
            LLM prompts and responses routed through Trace Flow may contain personally identifiable
            information, proprietary code, trade secrets, or other sensitive content. You are
            responsible for what data you send through the proxy. We store this content to provide
            the Service but do not analyze, mine, or use it for any purpose beyond displaying it
            back to you.
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
                ['Sentry', 'Error tracking', 'https://sentry.io/privacy/'],
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
