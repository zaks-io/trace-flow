import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'Terms of Service for Trace Flow, an LLM observability platform by Zaks.io LLC.',
};

function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-baseline gap-3 text-sm font-semibold text-foreground">
        <span className="font-mono text-[11px] tabular-nums text-primary/40">
          {String(number).padStart(2, '0')}
        </span>
        {title}
      </h2>
      <div className="space-y-3 pl-8 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary/70">
          Legal &middot; Terms
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Terms of Service
        </h1>
        <p className="font-mono text-[11px] text-muted-foreground/50">Effective March 9, 2026</p>
      </header>

      <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-relaxed text-primary">
        <strong className="font-semibold">Beta Service.</strong> Trace Flow is currently in beta.
        Features, policies, and data retention may change. This service is not recommended for
        production workloads.
      </div>

      <div className="space-y-8">
        <Section number={1} title="Service Description">
          <p>
            Trace Flow (&ldquo;the Service&rdquo;) is an LLM observability proxy operated by Zaks.io
            LLC (&ldquo;we&rdquo;, &ldquo;us&rdquo;). The Service captures metadata and
            request/response data from LLM API calls and presents it through dashboards, analytics,
            and debugging tools.
          </p>
        </Section>

        <Section number={2} title="Eligibility and Access">
          <p>
            Access to the Service is by invitation only. We reserve the right to grant or revoke
            access at any time, with or without notice.
          </p>
        </Section>

        <Section number={3} title="Acceptable Use">
          <p>You agree not to:</p>
          <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/30">
            <li>Attempt to access another user&apos;s or organization&apos;s data</li>
            <li>Reverse engineer, scrape, or overload the Service</li>
            <li>Use the Service for any unlawful purpose</li>
            <li>Redistribute access credentials</li>
          </ul>
          <p>
            You acknowledge that LLM prompts and responses routed through the proxy may contain
            sensitive information. You are solely responsible for ensuring that data you send
            through the Service complies with applicable laws and regulations. Do not send regulated
            data (e.g. PHI, financial PII) through the Service unless you accept the associated
            risk.
          </p>
        </Section>

        <Section number={4} title="Data and Privacy">
          <p>
            Your use of the Service is also governed by our{' '}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            . You retain ownership of your data. We do not sell or share your data with third
            parties beyond what is necessary to operate the Service.
          </p>
        </Section>

        <Section number={5} title="API Credentials">
          <p>
            You may provide LLM provider API credentials (API keys, OAuth tokens) to use with the
            Service. You provide these credentials at your own risk. You are responsible for all
            activity conducted using credentials associated with your account. We are not
            responsible for unauthorized access, credential leakage, or misuse.
          </p>
        </Section>

        <Section number={6} title="Service Availability">
          <p>
            The Service is provided on a best-effort basis. We do not guarantee any uptime,
            availability, or data durability. There is no SLA. The Service may be modified,
            suspended, or discontinued at any time.
          </p>
        </Section>

        <Section number={7} title="Disclaimer of Warranties">
          <p className="font-mono text-xs leading-relaxed">
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
            WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
          </p>
        </Section>

        <Section number={8} title="Limitation of Liability">
          <p className="font-mono text-xs leading-relaxed">
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, ZAKS.IO LLC SHALL NOT BE LIABLE FOR ANY
            INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA,
            PROFITS, OR REVENUE, ARISING FROM YOUR USE OF THE SERVICE.
          </p>
        </Section>

        <Section number={9} title="Termination">
          <p>
            We may terminate or suspend your access at any time, for any reason. You may stop using
            the Service at any time. Upon termination, you may request deletion of your data by
            contacting us.
          </p>
        </Section>

        <Section number={10} title="Third-Party Dependencies">
          <p>
            The Service depends on third-party LLM APIs (such as OpenAI, Anthropic, Google, and
            others). If those services become unavailable or change their terms, Trace Flow may not
            function as expected. We are not liable for third-party API outages, pricing changes, or
            policy modifications.
          </p>
        </Section>

        <Section number={11} title="Changes to These Terms">
          <p>
            We may update these terms at any time. Continued use of the Service after changes
            constitutes acceptance of the updated terms.
          </p>
        </Section>

        <Section number={12} title="Contact">
          <p>
            Questions about these terms? Contact us at{' '}
            <a href="mailto:legal@zaks.io" className="text-primary hover:underline">
              legal@zaks.io
            </a>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}
