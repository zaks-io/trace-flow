import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth0';
import { AppLayoutClient } from './AppLayoutClient';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect('/auth/login?returnTo=/app');
  }

  return <AppLayoutClient>{children}</AppLayoutClient>;
}
