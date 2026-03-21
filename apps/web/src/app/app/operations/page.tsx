import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Operations from '@/components/pages/Operations';

export default async function OperationsPage() {
  const token = await getConvexToken();
  const preloadedApiKeys = await preloadQuery(api.apiKeys.list, {}, { token });

  return <Operations preloadedApiKeys={preloadedApiKeys} />;
}
