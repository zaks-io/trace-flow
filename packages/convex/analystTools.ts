import { createTool, type ToolCtx } from '@convex-dev/agent';
import { jsonSchema } from 'ai';
import {
  dispatchToolCall,
  getTraceFlowToolDefinitions,
  LATEST_PROTOCOL_VERSION,
  type ToolCallParams,
  type ToolCallResult,
} from '@trace-flow/mcp-core';
import { getEnabledActionUser, requireAnalystProEntitlement } from './analyst';
import { internal } from './_generated/api';
import { createMcpBackend } from './mcp/backend';
import { withTinybirdTracing } from './tinybirdTracing';
import type { ActionCtx } from './_generated/server';
import type { DataModel, Id } from './_generated/dataModel';

const TINYBIRD_BASE_URL = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';

async function runTraceFlowTool(
  ctx: ActionCtx,
  userId: Id<'users'>,
  orgId: Id<'organizations'>,
  params: ToolCallParams,
): Promise<ToolCallResult> {
  await requireAnalystProEntitlement(ctx, orgId);
  const response = await withTinybirdTracing((sentryScope) =>
    dispatchToolCall(
      createMcpBackend(ctx, userId, sentryScope, orgId),
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
          if (!ctx.threadId) throw new Error('Conversation not found');
          const userId = ctx.userId
            ? (ctx.userId as Id<'users'>)
            : (await getEnabledActionUser(ctx))._id;
          const thread = await ctx.runQuery(internal.analyst.getThreadByAgentThreadIdForAction, {
            agentThreadId: ctx.threadId,
            userId,
          });
          if (!thread) throw new Error('Conversation not found');
          return runTraceFlowTool(ctx, userId, thread.orgId, {
            name: definition.name,
            arguments: input,
          });
        },
      }),
    ]),
  );
}
