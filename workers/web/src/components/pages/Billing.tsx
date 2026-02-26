'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { usePageHeader } from '@/components/PageHeaderContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

function formatCents(cents?: number): string {
  if (cents === undefined || cents === null) return 'No cap';
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Billing() {
  usePageHeader('Billing');
  const summary = useQuery(api.subscriptions.getBillingSummaryForCurrentUser);
  const createPortal = useAction(api.subscriptions.createBillingPortalSession);
  const createCheckout = useAction(api.subscriptions.createOrgCheckoutSession);
  const createAddonCheckout = useAction(api.subscriptions.createAddonCheckoutSession);
  const updateSeats = useAction(api.subscriptions.updateSeatQuantity);
  const reconcile = useAction(api.subscriptions.reconcileCurrentOrgWithStripe);
  const updateAutoOverage = useMutation(api.subscriptions.updateAutoOverageSettings);

  const [seatQuantity, setSeatQuantity] = useState('1');
  const [addonPackages, setAddonPackages] = useState('1');
  const [autoOverage, setAutoOverage] = useState(false);
  const [overageCap, setOverageCap] = useState('50');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!summary?.subscription) return;
    setSeatQuantity(String(summary.subscription.seatQuantity ?? 1));
    setAutoOverage(Boolean(summary.subscription.autoOverage));
    if (summary.subscription.overageCapCents !== undefined) {
      setOverageCap((summary.subscription.overageCapCents / 100).toFixed(2));
    }
  }, [summary?.subscription]);

  const usageCopy = useMemo(() => {
    if (!summary?.subscription) return null;
    return `${summary.activeMembers} active members / ${summary.subscription.seatQuantity ?? 1} seats`;
  }, [summary]);

  const withBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  if (summary === undefined) {
    return <div className="text-sm text-muted-foreground">Loading billing details...</div>;
  }

  if (!summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Billing unavailable</CardTitle>
          <CardDescription>No organization billing data found.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>
            {summary.subscription.tier.toUpperCase()} plan, status{' '}
            {summary.subscription.status ?? 'active'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {summary.subscription.cancelAtPeriodEnd && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              Your subscription will end on{' '}
              {new Date(summary.subscription.currentPeriodEnd).toLocaleDateString()}. You can
              resubscribe from the billing portal.
            </div>
          )}
          <div className="text-sm text-muted-foreground">{usageCopy}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Seat quantity</label>
              <Input
                type="number"
                min={1}
                value={seatQuantity}
                onChange={(e) => setSeatQuantity(e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                onClick={() =>
                  void withBusy('seats', async () => {
                    await updateSeats({ seatQuantity: Math.max(1, Number(seatQuantity) || 1) });
                  })
                }
                disabled={busy !== null}
              >
                {busy === 'seats' ? 'Updating...' : 'Update Seats'}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void withBusy('portal', async () => {
                    const res = await createPortal({});
                    if (res.url) window.location.href = res.url;
                  })
                }
                disabled={busy !== null}
              >
                {busy === 'portal' ? 'Opening...' : 'Manage Billing'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage Capacity</CardTitle>
          <CardDescription>
            Included units: {summary.subscription.monthlyUnits.toLocaleString()} and addons:{' '}
            {summary.subscription.addonUnits.toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void withBusy('upgrade', async () => {
                const res = await createCheckout({});
                if (res.url) window.location.href = res.url;
              })
            }
            disabled={busy !== null}
          >
            {busy === 'upgrade' ? 'Opening...' : 'Start / Upgrade Subscription'}
          </Button>
          <Input
            type="number"
            min={1}
            value={addonPackages}
            onChange={(e) => setAddonPackages(e.target.value)}
            className="w-44"
            placeholder="Packages (100k units each)"
          />
          <Button
            variant="outline"
            onClick={() =>
              void withBusy('addon', async () => {
                const res = await createAddonCheckout({
                  quantity: Math.max(1, Math.floor(Number(addonPackages) || 1)),
                });
                if (res.url) window.location.href = res.url;
              })
            }
            disabled={busy !== null || summary.subscription.tier !== 'pro'}
          >
            {busy === 'addon' ? 'Opening...' : 'Buy Addon Pack'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-topup</CardTitle>
          <CardDescription>
            Optional prepaid topups with monthly spend cap. Current cap:{' '}
            {formatCents(summary.subscription.overageCapCents)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={autoOverage} onCheckedChange={setAutoOverage} />
            <span className="text-sm text-muted-foreground">Enable auto-topup</span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={overageCap}
              onChange={(e) => setOverageCap(e.target.value)}
              className="w-44"
            />
            <Button
              variant="outline"
              onClick={() =>
                void withBusy('overage', async () => {
                  await updateAutoOverage({
                    autoOverage,
                    overageCapCents: Math.max(0, Math.round((Number(overageCap) || 0) * 100)),
                  });
                })
              }
              disabled={busy !== null || summary.subscription.tier !== 'pro'}
            >
              {busy === 'overage' ? 'Saving...' : 'Save Auto-topup'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recovery</CardTitle>
          <CardDescription>
            Force a Stripe reconciliation if local billing state looks stale.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() =>
              void withBusy('reconcile', async () => {
                await reconcile({});
              })
            }
            disabled={busy !== null}
          >
            {busy === 'reconcile' ? 'Reconciling...' : 'Reconcile Billing State'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
