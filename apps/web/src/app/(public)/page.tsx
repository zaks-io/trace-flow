import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth0';
import { HeroSection } from '@/components/landing/HeroSection';
import { CodeExample } from '@/components/landing/CodeExample';
import { FeaturesGrid } from '@/components/landing/FeaturesGrid';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { PricingSection } from '@/components/landing/PricingSection';
import { FooterCTA } from '@/components/landing/FooterCTA';

export default async function HomePage() {
  const session = await getSession();
  if (session) {
    redirect('/app');
  }

  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === 'true';

  return (
    <main>
      <HeroSection isWaitlistMode={isWaitlistMode} />
      <CodeExample />
      <FeaturesGrid />
      <HowItWorks />
      <PricingSection />
      <FooterCTA isWaitlistMode={isWaitlistMode} />
    </main>
  );
}
