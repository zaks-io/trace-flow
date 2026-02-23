import { redirect } from 'next/navigation';
import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getSession } from '@/lib/auth0';
import { getConvexToken } from '@/lib/convex';
import { AppLayoutClient } from './AppLayoutClient';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect('/auth/login?returnTo=/app');
  }

  const token = await getConvexToken(session);
  const preloadedSessionContext = await preloadQuery(api.app.sessionContext, {}, { token });

  return (
    <AppLayoutClient preloadedSessionContext={preloadedSessionContext}>{children}</AppLayoutClient>
  );
}
