import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Usage from '@/components/pages/Usage';

export default async function DashboardPage() {
  const token = await getConvexToken();
  const preloadedApiKeys = await preloadQuery(api.apiKeys.list, {}, { token });

  return <Usage preloadedApiKeys={preloadedApiKeys} />;
}
