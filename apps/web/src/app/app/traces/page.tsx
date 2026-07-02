import { preloadQuery } from 'convex/nextjs';
import { api } from '@trace-flow/convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Traces from '@/components/traces/Traces';

export default async function TracesPage() {
  const token = await getConvexToken();
  const [preloadedAlerts, preloadedApiKeys] = await Promise.all([
    preloadQuery(api.alerts.listEnabled, {}, { token }),
    preloadQuery(api.apiKeys.list, {}, { token }),
  ]);

  return <Traces preloadedAlerts={preloadedAlerts} preloadedApiKeys={preloadedApiKeys} />;
}
