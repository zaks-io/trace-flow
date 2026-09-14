import { expect, test } from 'bun:test';
import type { CanonicalHashIndex } from './agent-canonical-index';
import { verifyAllFrozenFacts } from './agent-frozen-verification';
import type { AgentRecoveryClient } from './agent-transport';

const identities = ['first', 'second', 'third'].map((factId) => ({
  category: 'messages' as const,
  factId,
}));
const metadata = identities.map((identity) => ({
  ...identity,
  sourceHash: 'a'.repeat(16),
  payloadBytes: 100,
  eventDay: '2025-09-13',
  ingestedAt: '2025-09-13 01:00:00.000',
}));
const index = { complete: true, oldestDay: '2025-09-14' } as CanonicalHashIndex;

test('prefetch overlaps one identity page while preserving the serial verification digest', async () => {
  const prefetched = Promise.withResolvers<void>();
  let inFlight = 0;
  let maximumInFlight = 0;
  let pages = 0;
  const recovery = {
    async call(method: string, input: any) {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      try {
        if (method === 'listFrozenFacts') {
          const position = pages++;
          if (position === 1) prefetched.resolve();
          return {
            facts: [identities[position]],
            nextAfter: position === identities.length - 1 ? null : identities[position],
          };
        }
        expect(method).toBe('inspectFrozenFactSources');
        if (input.facts[0].factId === 'first') await prefetched.promise;
        return metadata.filter((row) => row.factId === input.facts[0].factId);
      } finally {
        inFlight--;
      }
    },
  } as unknown as AgentRecoveryClient;
  const serial = {
    async call(method: string) {
      return method === 'listFrozenFacts' ? { facts: identities, nextAfter: null } : metadata;
    },
  } as unknown as AgentRecoveryClient;
  const report = await verifyAllFrozenFacts(recovery, index);
  expect(report).toEqual(await verifyAllFrozenFacts(serial, index));
  expect(report).toMatchObject({ total: 3, expired: 3, eligibleForLegacyRetirement: true });
  expect(maximumInFlight).toBe(2);
  expect(inFlight).toBe(0);
  expect(pages).toBe(3);
});

test('a failed prefetched page drains current verification before rejecting', async () => {
  const failedPage = Promise.withResolvers<void>();
  const releaseInspection = Promise.withResolvers<void>();
  const failure = new Error('Identity page unavailable');
  let inspectionFinished = false;
  let pages = 0;
  let settled = false;
  const recovery = {
    async call(method: string) {
      if (method === 'listFrozenFacts') {
        if (pages++ === 0) return { facts: [identities[0]], nextAfter: identities[0] };
        failedPage.resolve();
        throw failure;
      }
      expect(method).toBe('inspectFrozenFactSources');
      await releaseInspection.promise;
      inspectionFinished = true;
      return [metadata[0]];
    },
  } as unknown as AgentRecoveryClient;
  const result = verifyAllFrozenFacts(recovery, index).then(
    () => {
      settled = true;
      throw new Error('Verification unexpectedly succeeded');
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await failedPage.promise;
  expect(settled).toBe(false);
  releaseInspection.resolve();
  expect(await result).toBe(failure);
  expect(inspectionFinished).toBe(true);
});
