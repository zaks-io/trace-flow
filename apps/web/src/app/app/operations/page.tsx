import { preloadQuery } from 'convex/nextjs';
import { api } from '@trace-flow/convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import { OperationsAnalytics as Operations } from '@/components/operations/OperationsAnalytics';

export default async function OperationsPage() {
  const token = await getConvexToken();
  const preloadedApiKeys = await preloadQuery(api.apiKeys.list, {}, { token });

  return <Operations preloadedApiKeys={preloadedApiKeys} />;
}
