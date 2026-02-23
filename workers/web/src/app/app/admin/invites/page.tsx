import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import AdminInvitesClient from './AdminInvitesClient';

export default async function AdminInvitesPage() {
  const token = await getConvexToken();
  const [preloadedInvites, preloadedWaitlist] = await Promise.all([
    preloadQuery(api.invites.listInvites, {}, { token }),
    preloadQuery(api.waitlist.listWaitlist, {}, { token }),
  ]);

  return (
    <AdminInvitesClient preloadedInvites={preloadedInvites} preloadedWaitlist={preloadedWaitlist} />
  );
}
