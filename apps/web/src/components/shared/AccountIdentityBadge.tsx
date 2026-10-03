import { cn } from '@/lib/utils';
import { identityLabel, type AccountCoverage } from '@/lib/upstreamAccount';

/** Only provider-verified identity gets the positive treatment; credentials never pass as accounts. */
export function AccountIdentityBadge({ coverage }: { coverage: AccountCoverage }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        coverage === 'provider-account'
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {identityLabel(coverage)}
    </span>
  );
}
