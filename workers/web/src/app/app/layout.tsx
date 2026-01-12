import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth0';
import { AppLayoutClient } from './AppLayoutClient';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect('/auth/login?returnTo=/app');
  }

  // Sync user to Convex on server-side
  const idToken = session.tokenSet?.idToken;
  if (idToken) {
    convex.setAuth(idToken);
    await convex.mutation(api.users.initializeUser, {}).catch(() => {
      // Ignore errors - user may already exist or token expired
    });
  }

  return <AppLayoutClient>{children}</AppLayoutClient>;
}
