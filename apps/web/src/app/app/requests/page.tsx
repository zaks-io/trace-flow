import { preloadQuery } from 'convex/nextjs';
import { api } from '@trace-flow/convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Requests from '@/components/requests/Requests';

export default async function RequestsPage() {
  const token = await getConvexToken();
  const [preloadedAlerts, preloadedApiKeys] = await Promise.all([
    preloadQuery(api.alerts.listEnabled, {}, { token }),
    preloadQuery(api.apiKeys.listAnalytics, {}, { token }),
  ]);

  return <Requests preloadedAlerts={preloadedAlerts} preloadedApiKeys={preloadedApiKeys} />;
}
