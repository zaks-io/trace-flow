import { preloadQuery } from 'convex/nextjs';
import { api } from '@trace-flow/convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import AlertsPageClient from './AlertsPageClient';

export default async function AlertsPage() {
  const token = await getConvexToken();
  const [preloadedAlerts, preloadedCostAlerts] = await Promise.all([
    preloadQuery(api.alerts.list, {}, { token }),
    preloadQuery(api.costAlerts.listForCurrentOrg, {}, { token }),
  ]);

  return (
    <AlertsPageClient preloadedAlerts={preloadedAlerts} preloadedCostAlerts={preloadedCostAlerts} />
  );
}
