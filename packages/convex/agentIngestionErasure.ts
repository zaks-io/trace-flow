import { v } from 'convex/values';
import { internalAction } from './_generated/server';

export const eraseOrganization = internalAction({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const host = process.env.AGENT_INGEST_URL;
    const secret = process.env.AGENT_INGEST_SHARED_SECRET;
    if (!host || !secret) throw new Error('Agent ingestion erasure is not configured');
    const url = new URL('/internal/organization-erasure', host);
    if (url.protocol !== 'https:') throw new Error('Agent ingestion erasure requires HTTPS');
    let afterId: number | undefined;
    const deadlineAt = Date.now() + 5 * 60_000;
    while (Date.now() < deadlineAt) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: args.orgId, afterId }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200 && response.status !== 202) {
        await response.body?.cancel();
        throw new Error(`Agent ingestion erasure failed: HTTP ${response.status}`);
      }
      const result: { ready?: boolean; nextAfterId?: number } = await response.json();
      if (result.ready === true && response.status === 200) return null;
      if (result.ready !== false || response.status !== 202)
        throw new Error('Invalid agent ingestion erasure response');
      if (result.nextAfterId !== undefined) {
        if (!Number.isSafeInteger(result.nextAfterId) || result.nextAfterId <= (afterId ?? 0))
          throw new Error('Invalid agent erasure continuation');
        afterId = result.nextAfterId;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      'Agent ingestion is still draining; deletion remains gated until outstanding writes settle',
    );
  },
});
