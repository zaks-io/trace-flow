import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Dashboard from '@/components/pages/Dashboard';

export default async function DashboardPage() {
  const token = await getConvexToken();
  const preloadedApiKeys = await preloadQuery(api.apiKeys.list, {}, { token });

  return <Dashboard preloadedApiKeys={preloadedApiKeys} />;
}
