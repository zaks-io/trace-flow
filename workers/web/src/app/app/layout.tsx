import { redirect } from 'next/navigation';
import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getSession } from '@/lib/auth0';
import { AppLayoutClient } from './AppLayoutClient';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect('/auth/login?returnTo=/app');
  }

  const token = session.tokenSet?.idToken;
  if (!token) {
    redirect('/auth/login?returnTo=/app');
  }

  const preloadedSessionContext = await preloadQuery(api.app.sessionContext, {}, { token }).catch(
    (e: unknown) => {
      console.warn('[SSR] Failed to preload sessionContext:', e);
      return null;
    },
  );

  return (
    <AppLayoutClient preloadedSessionContext={preloadedSessionContext}>{children}</AppLayoutClient>
  );
}
