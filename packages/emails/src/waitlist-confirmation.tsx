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

interface WaitlistConfirmationEmailProps {
  confirmUrl: string;
}

export function WaitlistConfirmationEmail({ confirmUrl }: WaitlistConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Confirm your spot on the Trace Flow waitlist</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Confirm your email</Text>
            <Text style={paragraph}>
              Thanks for your interest in Trace Flow! Please confirm your email address to secure
              your spot on our waitlist. We&apos;ll notify you as soon as access is available.
            </Text>
            <Button style={button} href={confirmUrl}>
              Confirm Email
            </Button>
            <Text style={footnote}>
              If you didn&apos;t sign up for Trace Flow, you can safely ignore this email.
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
