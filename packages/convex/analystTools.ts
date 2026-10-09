import { createTool, type ToolCtx } from '@convex-dev/agent';
import { jsonSchema } from 'ai';
import {
  dispatchToolCall,
  getTraceFlowToolDefinitions,
  LATEST_PROTOCOL_VERSION,
  type ToolCallParams,
  type ToolCallResult,
} from '@trace-flow/mcp-core';
import { getEnabledActionUser, getEnabledUserById, requireAnalystProEntitlement } from './analyst';
import { createMcpBackend } from './mcp/backend';
import { withTinybirdTracing } from './tinybirdTracing';
import type { ActionCtx } from './_generated/server';
import type { DataModel, Id } from './_generated/dataModel';

const TINYBIRD_BASE_URL = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';

async function runTraceFlowTool(
  ctx: ActionCtx,
  userId: Id<'users'>,
  params: ToolCallParams,
): Promise<ToolCallResult> {
  const user = await getEnabledUserById(ctx, userId);
  await requireAnalystProEntitlement(ctx, user.orgId);
  const response = await withTinybirdTracing((sentryScope) =>
    dispatchToolCall(
      createMcpBackend(ctx, userId, sentryScope),
      TINYBIRD_BASE_URL,
      Date.now(),
      params,
      LATEST_PROTOCOL_VERSION,
      'analyst',
      sentryScope,
    ),
  );

  if (response.error) throw new Error(response.error.message);
  const result = response.result as ToolCallResult;
  if (result.isError) {
    throw new Error(
      result.content.map((part) => part.text ?? part.data ?? '').join('\n') || 'Tool failed',
    );
  }
  return result;
}

export function buildAnalystTools() {
  return Object.fromEntries(
    getTraceFlowToolDefinitions('analyst').map((definition) => [
      definition.name,
      createTool({
        title: definition.title,
        description: definition.description,
        inputSchema: jsonSchema<Record<string, unknown>>(
          definition.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (ctx: ToolCtx<DataModel>, input) => {
          const userId = ctx.userId
            ? (ctx.userId as Id<'users'>)
            : (await getEnabledActionUser(ctx))._id;
          return runTraceFlowTool(ctx, userId, { name: definition.name, arguments: input });
        },
      }),
    ]),
  );
}
