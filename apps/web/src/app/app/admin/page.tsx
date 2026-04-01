'use client';

import { useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { useIsAdmin } from '@/components/admin/AdminContext';
import {
  Users,
  Building2,
  Key,
  DollarSign,
  RefreshCw,
  ArrowDownToLine,
  CloudUpload,
  Database,
  CheckCircle2,
  XCircle,
  Loader2,
  Crown,
  Sparkles,
  Trash2,
  AlertTriangle,
  HeartPulse,
  Zap,
} from 'lucide-react';

type ActionStatus = 'idle' | 'loading' | 'success' | 'error';

const statAccents = {
  purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
  blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
  amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
  emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
} as const;

const iconAccents = {
  purple: 'text-purple-400',
  blue: 'text-blue-400',
  amber: 'text-amber-400',
  emerald: 'text-emerald-400',
} as const;

type Accent = keyof typeof statAccents;

function StatCard({
  icon,
  label,
  value,
  accent = 'purple',
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  accent?: Accent;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-linear-to-br p-4 ${statAccents[accent]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {value ?? '-'}
          </p>
        </div>
        <div className={`rounded-lg bg-background/50 p-2 ${iconAccents[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}

function SyncActionRow({
  icon,
  label,
  description,
  onRun,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onRun: () => Promise<string>;
}) {
  const [status, setStatus] = useState<ActionStatus>('idle');
  const [message, setMessage] = useState('');

  async function handleClick() {
    setStatus('loading');
    setMessage('');
    try {
      const result = await onRun();
      setMessage(result);
      setStatus('success');
      setTimeout(() => {
        setStatus('idle');
        setMessage('');
      }, 5000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
      setStatus('error');
    }
  }

  return (
    <div className="group flex items-center justify-between rounded-xl border border-border bg-card p-4 transition-colors hover:border-border/80 hover:bg-card/80">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {message && (
          <span
            className={`flex items-center gap-1.5 text-xs font-medium ${
              status === 'error' ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {status === 'success' && <CheckCircle2 className="h-3.5 w-3.5" />}
            {status === 'error' && <XCircle className="h-3.5 w-3.5" />}
            {message}
          </span>
        )}
        <Button
          size="sm"
          variant={status === 'error' ? 'destructive' : 'default'}
          disabled={status === 'loading'}
          onClick={() => void handleClick()}
          className="min-w-[72px]"
        >
          {status === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : status === 'error' ? (
            'Retry'
          ) : (
            'Run'
          )}
        </Button>
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  grace: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
  suspended: 'border-red-500/30 bg-red-500/15 text-red-400',
  canceled: 'border-red-500/30 bg-red-500/15 text-red-400',
  missing: 'border-red-500/30 bg-red-500/15 text-red-400',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_COLORS[status] ?? STATUS_COLORS.missing}`}
    >
      {status}
    </span>
  );
}

function formatRelativeTime(ms: number): string {
  const diff = ms - Date.now();
  const absDiff = Math.abs(diff);
  const days = Math.floor(absDiff / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  const label = days === 1 ? '1 day' : `${days} days`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

function SubscriptionHealthSection() {
  const isAdmin = useIsAdmin();
  const health = useQuery(api.admin.admin.listOrgSubscriptionHealth, isAdmin ? {} : 'skip');
  const forceActivate = useAction(api.admin.admin.forceActivateAndVerify);
  const [showOnlyIssues, setShowOnlyIssues] = useState(true);
  const [activatingOrgId, setActivatingOrgId] = useState<Id<'organizations'> | null>(null);
  const [expandedOrgId, setExpandedOrgId] = useState<Id<'organizations'> | null>(null);
  const [tier, setTier] = useState<'hobby' | 'pro'>('pro');
  const [monthlyUnits, setMonthlyUnits] = useState<number>(999_999_999);
  const [periodDays, setPeriodDays] = useState<number>(365);
  const [result, setResult] = useState<{
    orgId: string;
    status: 'success' | 'error';
    message: string;
  } | null>(null);

  const filtered = showOnlyIssues ? health?.filter((row) => row.issues.length > 0) : health;

  const issueCount = health?.filter((row) => row.issues.length > 0).length ?? 0;

  async function handleForceActivate(orgId: Id<'organizations'>) {
    setActivatingOrgId(orgId);
    setResult(null);
    try {
      const r = await forceActivate({ orgId, tier, monthlyUnits, periodDays });
      setResult({
        orgId,
        status: 'success',
        message: r.kvVerified ? 'Activated & KV verified' : 'Activated (KV unverified)',
      });
      setExpandedOrgId(null);
    } catch (err) {
      setResult({
        orgId,
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setActivatingOrgId(null);
    }
  }

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium text-foreground">Subscription Health</h2>
          {issueCount > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-400">
              {issueCount} issue{issueCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showOnlyIssues}
            onChange={(e) => setShowOnlyIssues(e.target.checked)}
            className="rounded border-border"
          />
          Issues only
        </label>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2">Organization</th>
              <th className="px-4 py-2">Tier</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Period End</th>
              <th className="px-4 py-2">Units</th>
              <th className="px-4 py-2">Issues</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!filtered && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {filtered?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {showOnlyIssues ? 'All orgs healthy' : 'No organizations'}
                </td>
              </tr>
            )}
            {filtered?.map((row) => (
              <tr key={row._id} className="group hover:bg-muted/20">
                <td className="px-4 py-2">
                  <div className="font-medium text-foreground">{row.name}</div>
                  {row.ownerEmail && (
                    <div className="text-[10px] text-muted-foreground">{row.ownerEmail}</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  {row.subscription ? (
                    <span className="font-mono text-xs">{row.subscription.tier}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge status={row.subscription?.status ?? 'missing'} />
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                  {row.subscription ? formatRelativeTime(row.subscription.currentPeriodEnd) : '-'}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                  {row.subscription
                    ? (row.subscription.monthlyUnits + row.subscription.addonUnits).toLocaleString()
                    : '-'}
                </td>
                <td className="px-4 py-2">
                  {row.issues.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {row.issues.map((issue) => (
                        <span
                          key={issue}
                          className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400"
                        >
                          {issue.replaceAll('_', ' ')}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    {result?.orgId === row._id && (
                      <span
                        className={`flex items-center gap-1 text-[10px] font-medium ${
                          result.status === 'error' ? 'text-red-400' : 'text-emerald-400'
                        }`}
                      >
                        {result.status === 'success' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        {result.message}
                      </span>
                    )}
                    {row.issues.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={activatingOrgId === row._id}
                        onClick={() => setExpandedOrgId(expandedOrgId === row._id ? null : row._id)}
                      >
                        {activatingOrgId === row._id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <Zap className="mr-1 h-3 w-3" />
                            Fix
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                  {expandedOrgId === row._id && (
                    <div className="mt-2 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/30 p-3">
                      <div>
                        <label className="mb-1 block text-[10px] text-muted-foreground">Tier</label>
                        <select
                          className="rounded border border-border bg-background px-2 py-1 text-xs"
                          value={tier}
                          onChange={(e) => setTier(e.target.value as 'hobby' | 'pro')}
                        >
                          <option value="hobby">Hobby</option>
                          <option value="pro">Pro</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-muted-foreground">
                          Monthly Units
                        </label>
                        <select
                          className="rounded border border-border bg-background px-2 py-1 text-xs"
                          value={monthlyUnits}
                          onChange={(e) => setMonthlyUnits(Number(e.target.value))}
                        >
                          <option value={25000}>25K (Hobby default)</option>
                          <option value={100000}>100K (Pro default)</option>
                          <option value={1000000}>1M</option>
                          <option value={999999999}>Unlimited</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-muted-foreground">
                          Period (days)
                        </label>
                        <input
                          type="number"
                          className="w-20 rounded border border-border bg-background px-2 py-1 text-xs"
                          value={periodDays}
                          min={1}
                          max={365}
                          onChange={(e) => setPeriodDays(Number(e.target.value))}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={activatingOrgId === row._id}
                        onClick={() => void handleForceActivate(row._id)}
                      >
                        {activatingOrgId === row._id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Zap className="mr-1 h-3 w-3" />
                        )}
                        Force Activate
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DangerZone() {
  const orgs = useQuery(api.admin.admin.listOrgs);
  const deleteOrgData = useAction(api.admin.admin.deleteOrgData);
  const [selectedOrgId, setSelectedOrgId] = useState<Id<'organizations'> | ''>('');
  const [confirmText, setConfirmText] = useState('');
  const [status, setStatus] = useState<ActionStatus>('idle');
  const [result, setResult] = useState('');

  const selectedOrg = orgs?.find((o) => o._id === selectedOrgId);
  const confirmMatch = selectedOrg && confirmText === selectedOrg.name;

  async function handleDelete() {
    if (!selectedOrgId || !confirmMatch) return;
    setStatus('loading');
    setResult('');
    try {
      const r = await deleteOrgData({ orgId: selectedOrgId as Id<'organizations'> });
      const tinybirdSummary =
        r.tinybirdResults.deleted === false
          ? r.tinybirdResults.reason
          : Object.entries(r.tinybirdResults.results)
              .map(([ds, res]) => `${ds}: ${res.success ? 'ok' : res.error}`)
              .join(', ');
      const convex = r.convexDeleted;
      setResult(
        `Tinybird: ${tinybirdSummary}. Convex: ${convex.apiKeys} keys, ${convex.usage} usage, ${convex.addonPurchases} addons, ${convex.membersRemoved} members, ${convex.invites} invites, ${convex.alerts} alerts, ${convex.mcpSessions} sessions, ${convex.mcpRefreshTokens} tokens. Stripe: ${r.stripeCanceled ? 'canceled' : 'n/a'}`,
      );
      setStatus('success');
      setSelectedOrgId('');
      setConfirmText('');
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Failed');
      setStatus('error');
    }
  }

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-400" />
        <h2 className="text-base font-medium text-red-400">Danger Zone</h2>
      </div>
      <div className="space-y-4 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <div>
          <p className="text-sm font-medium text-foreground">Delete All Organization Data</p>
          <p className="text-xs text-muted-foreground">
            Permanently deletes all traces, API keys, usage records, and Convex data for an org.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Organization</label>
            <select
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              value={selectedOrgId}
              onChange={(e) => {
                setSelectedOrgId(e.target.value as Id<'organizations'> | '');
                setConfirmText('');
                setStatus('idle');
                setResult('');
              }}
            >
              <option value="">Select an org...</option>
              {orgs?.map((org) => (
                <option key={org._id} value={org._id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>

          {selectedOrg && (
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">
                Type <span className="font-mono font-semibold">{selectedOrg.name}</span> to confirm
              </label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={selectedOrg.name}
              />
            </div>
          )}

          <Button
            size="sm"
            variant="destructive"
            disabled={!confirmMatch || status === 'loading'}
            onClick={() => void handleDelete()}
            className="min-w-[140px]"
          >
            {status === 'loading' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete Org Data
              </>
            )}
          </Button>
        </div>

        {result && (
          <div
            className={`rounded-lg border p-3 text-xs ${
              status === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-400'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
            }`}
          >
            {result}
          </div>
        )}
      </div>
    </section>
  );
}

export default function AdminPage() {
  const isAdmin = useIsAdmin();
  const stats = useQuery(api.admin.admin.stats, isAdmin ? {} : 'skip');

  const syncDefaults = useAction(api.billing.modelPricing.syncDefaults);
  const importFromOpenRouter = useAction(api.billing.modelPricing.importFromOpenRouter);
  const syncAllToKV = useAction(api.billing.modelPricing.syncAllToKV);
  const syncAll = useAction(api.integrations.cloudflare.syncAll);

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
    <div className="animate-fade-in space-y-8">
      <PageToolbar>
        <h1 className="text-sm font-medium text-foreground">System Overview</h1>
      </PageToolbar>

      <section>
        <div className="mb-4 flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium text-foreground">Platform Stats</h2>
        </div>
        <div className="stagger-children grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            icon={<Users className="h-4 w-4" />}
            label="Users"
            value={stats?.userCount}
            accent="purple"
          />
          <StatCard
            icon={<Building2 className="h-4 w-4" />}
            label="Organizations"
            value={stats?.orgCount}
            accent="blue"
          />
          <StatCard
            icon={<Key className="h-4 w-4" />}
            label="API Keys"
            value={stats?.apiKeyCount}
            accent="amber"
          />
          <StatCard
            icon={<DollarSign className="h-4 w-4" />}
            label="Model Pricing"
            value={stats?.modelPricingCount}
            accent="emerald"
          />
          <StatCard
            icon={<Sparkles className="h-4 w-4" />}
            label="Hobby Tier"
            value={stats?.tierBreakdown.hobby}
            accent="blue"
          />
          <StatCard
            icon={<Crown className="h-4 w-4" />}
            label="Pro Tier"
            value={stats?.tierBreakdown.pro}
            accent="amber"
          />
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium text-foreground">Sync Actions</h2>
        </div>
        <div className="stagger-children space-y-2">
          <SyncActionRow
            icon={<RefreshCw className="h-4 w-4" />}
            label="Sync Default Pricing"
            description="Upsert built-in model pricing from defaults"
            onRun={async () => {
              const r = await syncDefaults();
              return `Synced ${r.synced} entries`;
            }}
          />
          <SyncActionRow
            icon={<ArrowDownToLine className="h-4 w-4" />}
            label="Import from OpenRouter"
            description="Fetch latest model pricing from OpenRouter API"
            onRun={async () => {
              const r = await importFromOpenRouter();
              return `Imported ${r.imported} models`;
            }}
          />
          <SyncActionRow
            icon={<CloudUpload className="h-4 w-4" />}
            label="Sync All Pricing to KV"
            description="Push all model pricing entries to Cloudflare KV"
            onRun={async () => {
              const r = await syncAllToKV();
              return `Synced ${r.synced} entries`;
            }}
          />
          <SyncActionRow
            icon={<Database className="h-4 w-4" />}
            label="Sync API Keys & Subscriptions"
            description="Push all API keys and subscriptions to Cloudflare KV"
            onRun={async () => {
              const r = await syncAll();
              return `Synced ${r.keySynced} keys, ${r.subSynced} subs`;
            }}
          />
        </div>
      </section>

      <SubscriptionHealthSection />

      <DangerZone />
    </div>
  );
}
