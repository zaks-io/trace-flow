import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth0';
import { HeroSection } from '@/components/landing/HeroSection';
import { CodeExample } from '@/components/landing/CodeExample';
import { ProductShowcase } from '@/components/landing/ProductShowcase';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { FooterCTA } from '@/components/landing/FooterCTA';
import { AIHistory } from '@/components/landing/AIHistory';
import { DesktopCapture } from '@/components/landing/DesktopCapture';

export default async function HomePage() {
  const session = await getSession();
  if (session) {
    redirect('/app');
  }

  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === 'true';

  return (
    <main>
      <HeroSection isWaitlistMode={isWaitlistMode} />
      <ProductShowcase />
      <HowItWorks />
      <DesktopCapture />
      <CodeExample />
      <AIHistory />
      <FooterCTA isWaitlistMode={isWaitlistMode} />
    </main>
  );
}
