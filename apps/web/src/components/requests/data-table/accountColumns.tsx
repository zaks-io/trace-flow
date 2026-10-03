import type { ColumnDef } from '@tanstack/react-table';
import { parseSpanAttributes } from '@trace-flow/spans';
import { TRACE_FLOW } from '@trace-flow/otel-conventions';
import { AccountIdentityBadge } from '@/components/shared/AccountIdentityBadge';
import {
  accountLabel,
  requestSourceLabel,
  tryParseAccountKey,
  UNRECOGNIZED_ACCOUNT_LABEL,
} from '@/lib/upstreamAccount';
import type { RequestRow } from './columns';

const empty = <span className="text-muted-foreground/50">-</span>;

export const accountColumns: ColumnDef<RequestRow>[] = [
  {
    id: 'source',
    accessorFn: (row) =>
      requestSourceLabel(parseSpanAttributes(row.SpanAttributes)[TRACE_FLOW.SOURCE]),
    header: 'Source',
    cell: ({ getValue }) => {
      const label = getValue<string | null>();
      return label ? <span className="text-muted-foreground">{label}</span> : empty;
    },
    meta: { category: 'standard', label: 'Source' },
  },
  {
    id: 'upstreamAccount',
    accessorKey: 'AccountKey',
    header: 'Account',
    cell: ({ getValue }) => {
      const key = getValue<string | undefined>();
      if (!key) return empty;
      const account = tryParseAccountKey(key);
      if (!account) {
        return (
          <span className="text-destructive" title={key}>
            {UNRECOGNIZED_ACCOUNT_LABEL}
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <span className="text-foreground">{accountLabel(account)}</span>
          <AccountIdentityBadge coverage={account.coverage} />
        </span>
      );
    },
    meta: { category: 'standard', label: 'Account' },
  },
];
