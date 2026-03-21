import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import TraceDetail from '@/components/traces/TraceDetail';

export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const token = await getConvexToken();
  const preloadedAlerts = await preloadQuery(api.alerts.listEnabled, {}, { token });

  return <TraceDetail traceId={traceId} preloadedAlerts={preloadedAlerts} />;
}
