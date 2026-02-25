'use client';

import { useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
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
    </div>
  );
}
