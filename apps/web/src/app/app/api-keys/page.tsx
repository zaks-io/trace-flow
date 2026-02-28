import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import ApiKeys from '@/components/pages/ApiKeys';

export default async function ApiKeysPage() {
  const token = await getConvexToken();
  const preloadedApiKeys = await preloadQuery(api.apiKeys.list, {}, { token });

  return <ApiKeys preloadedApiKeys={preloadedApiKeys} />;
}
