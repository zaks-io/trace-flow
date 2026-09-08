import { preloadQuery } from 'convex/nextjs';
import { api } from '@trace-flow/convex/_generated/api';
import { ArchiveSetup } from '@/components/archive/ArchiveSetup';
import { getConvexToken } from '@/lib/convex';

export default async function ArchiveSettingsPage() {
  const token = await getConvexToken();
  const [preloadedStatus, preloadedCollectors] = await Promise.all([
    preloadQuery(api.archive.getStatus, {}, { token }),
    preloadQuery(api.collectorCredentials.listActiveForCurrentUser, {}, { token }),
  ]);

  return (
    <ArchiveSetup preloadedStatus={preloadedStatus} preloadedCollectors={preloadedCollectors} />
  );
}
