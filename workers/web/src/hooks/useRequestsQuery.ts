import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { TableFilters } from './useTableFilters';
import type { RequestRow } from '@/components/requests-table';

function escapeSQL(value: string): string {
  return value.replace(/'/g, "''");
}

function buildApiKeyFilter(apiKeys: string[]): string {
  if (apiKeys.length === 0) return '';
  const escaped = apiKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
  return `ApiKey IN (${escaped})`;
}

function buildSQL(filters: TableFilters, apiKeys: string[]): string {
  const conditions: string[] = ["SpanName = 'ai.request'"];

  const apiKeyFilter = buildApiKeyFilter(apiKeys);
  if (apiKeyFilter) conditions.push(apiKeyFilter);

  if (filters.provider) {
    conditions.push(
      `JSONExtractString(SpanAttributes, 'ai.provider') = '${escapeSQL(filters.provider)}'`,
    );
  }
  if (filters.model) {
    conditions.push(
      `JSONExtractString(SpanAttributes, 'ai.model') = '${escapeSQL(filters.model)}'`,
    );
  }
  if (filters.status) {
    conditions.push(`StatusCode = '${escapeSQL(filters.status)}'`);
  }
  if (filters.search) {
    const escaped = escapeSQL(filters.search);
    conditions.push(`(TraceId LIKE '%${escaped}%' OR ServiceName LIKE '%${escaped}%')`);
  }

  return `SELECT ReceivedAt, Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode, SpanAttributes
    FROM otel_traces
    WHERE ${conditions.join(' AND ')}
    ORDER BY ReceivedAt DESC
    LIMIT 100
    FORMAT JSON`;
}

interface UseRequestsQueryOptions {
  filters: TableFilters;
  apiKeys: string[];
  isLiveMode: boolean;
}

export function useRequestsQuery({ filters, apiKeys, isLiveMode }: UseRequestsQueryOptions) {
  const generateToken = useAction(api.tinybird.generateToken);

  return useQuery({
    queryKey: ['requests', filters, apiKeys],
    queryFn: async (): Promise<RequestRow[]> => {
      const { token } = await generateToken({
        scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
      });

      const apiUrl = import.meta.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
      const url = new URL(`${apiUrl}/v0/sql`);
      url.searchParams.set('q', buildSQL(filters, apiKeys));

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Tinybird query failed: ${response.status}`);
      }

      const result = await response.json();
      return result.data;
    },
    placeholderData: keepPreviousData,
    enabled: apiKeys.length > 0,
    refetchInterval: isLiveMode ? 3000 : undefined,
  });
}
