import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth0';
import { HeroSection } from '@/components/landing/HeroSection';
import { ProductShowcase } from '@/components/landing/ProductShowcase';
import { SetupSection } from '@/components/landing/SetupSection';
import { PrivacySection } from '@/components/landing/PrivacySection';
import { FooterCTA } from '@/components/landing/FooterCTA';
import { HomePageProvider } from '@/components/landing/HomePageProvider';

export default async function HomePage() {
  const session = await getSession();
  if (session) {
    redirect('/app');
  }

  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === 'true';

  return (
    <HomePageProvider isWaitlistMode={isWaitlistMode}>
      <main>
        <HeroSection isWaitlistMode={isWaitlistMode} />
        <ProductShowcase />
        <SetupSection />
        <PrivacySection />
        <FooterCTA isWaitlistMode={isWaitlistMode} />
      </main>
    </HomePageProvider>
  );
}
