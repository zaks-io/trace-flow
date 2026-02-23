'use client';

import { useState } from 'react';
import { type Preloaded, usePreloadedQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { type Doc } from '@convex/_generated/dataModel';
import { useIsAdmin } from '@/components/AdminContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function SendInviteForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const createInvite = useMutation(api.invites.createInvite);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus('sending');
    setErrorMessage('');

    try {
      await createInvite({ email });
      setStatus('sent');
      setEmail('');
      setTimeout(() => setStatus('idle'), 3000);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to send invite');
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex items-end gap-3">
      <div className="flex-1">
        <Label htmlFor="invite-email" className="mb-2">
          Email address
        </Label>
        <Input
          id="invite-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          disabled={status === 'sending'}
        />
      </div>
      <Button type="submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending...' : status === 'sent' ? 'Sent!' : 'Send Invite'}
      </Button>
      {status === 'error' && <p className="text-sm text-destructive">{errorMessage}</p>}
    </form>
  );
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusVariant(status: string) {
  switch (status) {
    case 'pending':
      return 'outline' as const;
    case 'accepted':
      return 'default' as const;
    case 'expired':
      return 'destructive' as const;
    default:
      return 'secondary' as const;
  }
}

function InvitesTable({
  preloadedInvites,
}: {
  preloadedInvites: Preloaded<typeof api.invites.listInvites>;
}) {
  const invites = usePreloadedQuery(preloadedInvites);
  const revokeInvite = useMutation(api.invites.revokeInvite);

  if (invites.length === 0)
    return <div className="text-muted-foreground">No invites sent yet.</div>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="w-[100px]">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invites.map((invite: Doc<'invites'>) => (
          <TableRow key={invite._id}>
            <TableCell className="font-medium">{invite.email}</TableCell>
            <TableCell>
              <Badge variant={statusVariant(invite.status)}>{invite.status}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDate(invite._creationTime)}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(invite.expiresAt)}</TableCell>
            <TableCell>
              {invite.status === 'pending' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revokeInvite({ inviteId: invite._id })}
                  className="text-destructive hover:text-destructive"
                >
                  Revoke
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WaitlistTable({
  preloadedWaitlist,
}: {
  preloadedWaitlist: Preloaded<typeof api.waitlist.listWaitlist>;
}) {
  const waitlist = usePreloadedQuery(preloadedWaitlist);
  const bulkInvite = useMutation(api.waitlist.bulkInviteFromWaitlist);
  const [isBulkInviting, setIsBulkInviting] = useState(false);

  if (waitlist.length === 0)
    return <div className="text-muted-foreground">No waitlist entries.</div>;

  const confirmedIds = waitlist
    .filter((e: Doc<'waitlist'>) => e.confirmed && !e.notifiedAt)
    .map((e: Doc<'waitlist'>) => e._id);

  async function handleBulkInvite() {
    if (confirmedIds.length === 0) return;
    setIsBulkInviting(true);
    try {
      await bulkInvite({ waitlistIds: confirmedIds });
    } finally {
      setIsBulkInviting(false);
    }
  }

  return (
    <div className="space-y-4">
      {confirmedIds.length > 0 && (
        <Button onClick={handleBulkInvite} disabled={isBulkInviting}>
          {isBulkInviting
            ? 'Sending invites...'
            : `Invite ${confirmedIds.length} confirmed ${confirmedIds.length === 1 ? 'entry' : 'entries'}`}
        </Button>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Confirmed</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead>Invited</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {waitlist.map((entry: Doc<'waitlist'>) => (
            <TableRow key={entry._id}>
              <TableCell className="font-medium">{entry.email}</TableCell>
              <TableCell>
                <Badge variant={entry.confirmed ? 'default' : 'outline'}>
                  {entry.confirmed ? 'Yes' : 'No'}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(entry._creationTime)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {entry.notifiedAt ? formatDate(entry.notifiedAt) : '-'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface AdminInvitesClientProps {
  preloadedInvites: Preloaded<typeof api.invites.listInvites>;
  preloadedWaitlist: Preloaded<typeof api.waitlist.listWaitlist>;
}

export default function AdminInvitesClient({
  preloadedInvites,
  preloadedWaitlist,
}: AdminInvitesClientProps) {
  const isAdmin = useIsAdmin();

  if (!isAdmin) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center">
          <h2 className="mb-2 text-xl font-semibold text-destructive">Access Denied</h2>
          <p className="text-destructive/80">You need admin access to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Invite Management</h1>
        <p className="text-muted-foreground">Send invites and manage the waitlist.</p>
      </div>

      <SendInviteForm />

      <Tabs defaultValue="invites">
        <TabsList>
          <TabsTrigger value="invites">Invites</TabsTrigger>
          <TabsTrigger value="waitlist">Waitlist</TabsTrigger>
        </TabsList>
        <TabsContent value="invites" className="mt-4">
          <InvitesTable preloadedInvites={preloadedInvites} />
        </TabsContent>
        <TabsContent value="waitlist" className="mt-4">
          <WaitlistTable preloadedWaitlist={preloadedWaitlist} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
