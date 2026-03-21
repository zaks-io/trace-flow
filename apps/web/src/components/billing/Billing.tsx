'use client';

import { useEffect, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

function formatCents(cents?: number): string {
  if (cents === undefined || cents === null) return '$0.00';
  return `$${(cents / 100).toFixed(2)}`;
}

function usageBarColor(percentage: number): string {
  if (percentage >= 90) return 'bg-destructive';
  if (percentage >= 75) return 'bg-yellow-500';
  return 'bg-primary';
}

const STATUS_BADGE_VARIANT = {
  active: 'default',
  grace: 'outline',
  suspended: 'destructive',
  canceled: 'destructive',
} as const;

export default function Billing() {
  const summary = useQuery(api.billing.subscriptions.getBillingSummaryForCurrentUser);
  const createPortal = useAction(api.billing.subscriptions.createBillingPortalSession);
  const createCheckout = useAction(api.billing.subscriptions.createOrgCheckoutSession);
  const createAddonCheckout = useAction(api.billing.subscriptions.createAddonCheckoutSession);
  const reconcile = useAction(api.billing.subscriptions.reconcileCurrentOrgWithStripe);
  const ensureBilling = useMutation(api.billing.subscriptions.ensureBillingForCurrentUser);
  const updateAutoOverage = useMutation(api.billing.subscriptions.updateAutoOverageSettings);

  const [addonPackages, setAddonPackages] = useState('1');
  const [autoOverage, setAutoOverage] = useState(false);
  const [overageCap, setOverageCap] = useState('50');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!summary?.subscription) return;
    setAutoOverage(Boolean(summary.subscription.autoOverage));
    if (summary.subscription.overageCapCents !== undefined) {
      setOverageCap((summary.subscription.overageCapCents / 100).toFixed(2));
    }
  }, [summary?.subscription]);

  useEffect(() => {
    if (summary === null) {
      ensureBilling().catch((e) => {
        console.error('Failed to ensure billing:', e);
        setError(e instanceof Error ? e.message : 'Failed to initialize billing');
      });
    }
  }, [summary, ensureBilling]);

  const isOwner = summary?.role === 'owner';

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

  if (summary === undefined || summary === null) {
    return <div className="text-sm text-muted-foreground">Setting up billing...</div>;
  }

  const { subscription, totalUsed, totalAvailable, remaining } = summary;
  const percentage = totalAvailable > 0 ? Math.round((totalUsed / totalAvailable) * 100) : 0;
  const addonQty = Math.max(1, Math.floor(Number(addonPackages) || 1));
  const overageSpent = subscription.currentPeriodOverageSpentCents ?? 0;
  const capRemaining =
    subscription.overageCapCents !== undefined
      ? subscription.overageCapCents - overageSpent
      : undefined;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Subscription */}
      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>
            Current period ends {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{subscription.tier.toUpperCase()}</Badge>
            <Badge variant={STATUS_BADGE_VARIANT[subscription.status]}>{subscription.status}</Badge>
          </div>
          {subscription.cancelAtPeriodEnd && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              Your subscription will end on{' '}
              {new Date(subscription.currentPeriodEnd).toLocaleDateString()}. You can resubscribe
              from the billing portal.
            </div>
          )}
          {isOwner && subscription.stripeSubscriptionId ? (
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
          ) : isOwner && !(subscription.tier === 'pro' && subscription.status === 'active') ? (
            <Button
              onClick={() =>
                void withBusy('upgrade', async () => {
                  const res = await createCheckout({});
                  if (res.url) window.location.href = res.url;
                })
              }
              disabled={busy !== null}
            >
              {busy === 'upgrade' ? 'Opening...' : 'Upgrade to Pro'}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* Usage */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>
            Resets {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm font-medium">
            {totalUsed.toLocaleString()} / {totalAvailable.toLocaleString()} units
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${usageBarColor(percentage)}`}
              style={{ width: `${Math.min(100, percentage)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{percentage}% used</span>
            <span>{remaining.toLocaleString()} remaining</span>
          </div>
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <div>Included: {subscription.monthlyUnits.toLocaleString()} units/mo</div>
            <div>Addon packs: {subscription.addonUnits.toLocaleString()} units</div>
          </div>
          {isOwner && subscription.tier === 'pro' && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-sm font-medium">Buy Addon Pack</p>
              <p className="text-xs text-muted-foreground">100k units per pack at $5.00 each</p>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={addonPackages}
                  onChange={(e) => setAddonPackages(e.target.value)}
                  className="w-24"
                  placeholder="Packs"
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    void withBusy('addon', async () => {
                      const res = await createAddonCheckout({ quantity: addonQty });
                      if (res.url) window.location.href = res.url;
                    })
                  }
                  disabled={busy !== null}
                >
                  {busy === 'addon'
                    ? 'Opening...'
                    : `Buy ${addonQty} pack${addonQty !== 1 ? 's' : ''}`}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Auto-Topup */}
      <Card>
        <CardHeader>
          <CardTitle>Auto-Topup</CardTitle>
          <CardDescription>
            Automatically purchases addon packs when usage reaches 90% of available units.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Charged this period</span>
              <span>{formatCents(overageSpent)}</span>
            </div>
            {capRemaining !== undefined && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Remaining cap budget</span>
                <span>{formatCents(Math.max(0, capRemaining))}</span>
              </div>
            )}
          </div>
          {isOwner ? (
            <>
              <div className="flex items-center gap-3 border-t pt-3">
                <Switch checked={autoOverage} onCheckedChange={setAutoOverage} />
                <span className="text-sm text-muted-foreground">Enable auto-topup</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Spending cap</span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={overageCap}
                  onChange={(e) => setOverageCap(e.target.value)}
                  className="w-32"
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
                  disabled={busy !== null || subscription.tier !== 'pro'}
                >
                  {busy === 'overage' ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Auto-topup: {subscription.autoOverage ? 'enabled' : 'disabled'} (cap:{' '}
              {formatCents(subscription.overageCapCents)}). Contact your org owner to change.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Recovery */}
      {isOwner && (
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
      )}
    </div>
  );
}
