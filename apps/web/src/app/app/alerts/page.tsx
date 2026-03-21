import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Alerts from '@/components/alerts/Alerts';

export default async function AlertsPage() {
  const token = await getConvexToken();
  const preloadedAlerts = await preloadQuery(api.alerts.list, {}, { token });

  return <Alerts preloadedAlerts={preloadedAlerts} />;
}
