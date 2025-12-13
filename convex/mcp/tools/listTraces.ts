import { internalAction } from '../../_generated/server';
import { v } from 'convex/values';
import type { ToolCallResult } from '../protocol';
import { jsonReplacer } from '../utils';
import { queryTinybird, noApiKeysError, generateTinybirdToken } from './shared';
import {
  normalizeParams,
  buildListTracesConditions,
  buildListTracesSQL,
  buildListTracesResult,
} from '../helpers/listTraces';

export const listTraces = internalAction({
  args: {
    apiKeys: v.array(v.string()),
    params: v.object({
      provider: v.optional(v.string()),
      model: v.optional(v.string()),
      status: v.optional(v.string()),
      limit: v.optional(v.number()),
      hours: v.optional(v.number()),
      cursor: v.optional(v.string()),
    }),
  },
  handler: async (_, args): Promise<ToolCallResult> => {
    const { apiKeys, params } = args;

    if (apiKeys.length === 0) {
      return noApiKeysError();
    }

    const token = await generateTinybirdToken([{ type: 'PIPES:READ', resource: 'otel_traces' }]);

    const { limit, hours, offset } = normalizeParams(params);
    const startTimeNs = (Date.now() - hours * 60 * 60 * 1000) * 1_000_000;

    const conditions = buildListTracesConditions(apiKeys, params, startTimeNs);
    const sql = buildListTracesSQL(conditions, limit, offset);
    const data = await queryTinybird(token, sql);
    const result = buildListTracesResult(data, limit, offset);

    return {
      content: [{ type: 'text', text: JSON.stringify(result, jsonReplacer) }],
    };
  },
});
