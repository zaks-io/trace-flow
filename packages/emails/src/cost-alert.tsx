import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Button,
  Hr,
  Preview,
} from '@react-email/components';

interface CostAlertEmailProps {
  organizationName: string;
  subject: string;
  summary: string;
  dashboardUrl: string;
}

export function CostAlertEmail({
  organizationName,
  subject,
  summary,
  dashboardUrl,
}: CostAlertEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={section}>
            <Text style={eyebrow}>{organizationName}</Text>
            <Text style={heading}>{subject}</Text>
            <Text style={paragraph}>{summary}</Text>
            <Button style={button} href={dashboardUrl}>
              Open Cost Alerts
            </Button>
            <Text style={footnote}>
              You are receiving this email because a Trace Flow cost alert channel is configured for
              this organization.
            </Text>
            <Hr style={hr} />
            <Text style={footer}>Trace Flow - LLM Observability</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body = {
  backgroundColor: '#0a0a0a',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

const container = {
  margin: '0 auto',
  padding: '40px 20px',
  maxWidth: '560px',
};

const section = {
  backgroundColor: '#1a1a1a',
  borderRadius: '8px',
  padding: '40px',
  border: '1px solid #2a2a2a',
};

const eyebrow = {
  color: '#737373',
  fontSize: '12px',
  fontWeight: '600' as const,
  letterSpacing: '0.08em',
  margin: '0 0 12px',
  textTransform: 'uppercase' as const,
};

const heading = {
  color: '#fafafa',
  fontSize: '24px',
  fontWeight: '600' as const,
  margin: '0 0 16px',
};

const paragraph = {
  color: '#a1a1a1',
  fontSize: '15px',
  lineHeight: '1.6',
  margin: '0 0 24px',
};

const button = {
  backgroundColor: '#e5e5e5',
  borderRadius: '6px',
  color: '#0a0a0a',
  display: 'inline-block',
  fontSize: '14px',
  fontWeight: '600' as const,
  padding: '12px 24px',
  textDecoration: 'none',
};

const footnote = {
  color: '#737373',
  fontSize: '13px',
  lineHeight: '1.5',
  margin: '24px 0 0',
};

const hr = {
  borderColor: '#2a2a2a',
  margin: '24px 0',
};

const footer = {
  color: '#525252',
  fontSize: '12px',
  margin: '0',
};
