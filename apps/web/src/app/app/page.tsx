import { preloadQuery } from 'convex/nextjs';
import { api } from '@trace-flow/convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Usage from '@/components/usage/Usage';

export default async function DashboardPage() {
  const token = await getConvexToken();
  const [preloadedApiKeys, preloadedAnalyticsApiKeys] = await Promise.all([
    preloadQuery(api.apiKeys.list, {}, { token }),
    preloadQuery(api.apiKeys.listAnalytics, {}, { token }),
  ]);

  return (
    <Usage
      preloadedApiKeys={preloadedApiKeys}
      preloadedAnalyticsApiKeys={preloadedAnalyticsApiKeys}
    />
  );
}
