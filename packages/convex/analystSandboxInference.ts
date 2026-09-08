import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action } from './_generated/server';
import { ANALYST_MODEL, requireAnalystProEntitlement } from './analyst';
import { SANDBOX_INFERENCE_MAX_OUTPUT_TOKENS_PER_REQUEST } from './analystSandboxPolicy';
import { sha256Hex } from './analystSandboxRun';

export const authorizeSandboxInference = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    requestedOutputTokens: v.number(),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    const run = await ctx.runQuery(internal.analystSandboxStore.getVerifiedSandboxRunForAction, {
      runId: args.runId,
      tokenHash,
    });
    if (!run) {
      return { ok: false as const, reason: 'unauthorized' as const, status: null, model: null };
    }

    await requireAnalystProEntitlement(ctx, run.orgId);
    const reservation = await ctx.runMutation(
      internal.analystSandboxStore.reserveSandboxInference,
      {
        runId: args.runId,
        tokenHash,
        requestedOutputTokens: args.requestedOutputTokens,
      },
    );
    return {
      ...reservation,
      model: reservation.ok ? ANALYST_MODEL : null,
      maxOutputTokens: SANDBOX_INFERENCE_MAX_OUTPUT_TOKENS_PER_REQUEST,
    };
  },
});
