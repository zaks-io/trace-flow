'use client';

import { useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { PageToolbar } from '@/components/PageToolbar';
import { useIsAdmin } from '@/components/AdminContext';
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

function DangerZone() {
  const orgs = useQuery(api.admin.listOrgs);
  const deleteOrgData = useAction(api.admin.deleteOrgData);
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
  const stats = useQuery(api.admin.stats, isAdmin ? {} : 'skip');

  const syncDefaults = useAction(api.modelPricing.syncDefaults);
  const importFromOpenRouter = useAction(api.modelPricing.importFromOpenRouter);
  const syncAllToKV = useAction(api.modelPricing.syncAllToKV);
  const syncAll = useAction(api.cloudflare.syncAll);

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

      <DangerZone />
    </div>
  );
}
