import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentDeliveryReference, AgentDeliveryStagedReference } from '@trace-flow/types';
import { envelope, emptyFacts, facts, messageFact } from './factories';
import { TEST_NOW, makeEnv, validCredEntries } from './handler-fixture';
import {
  authHeaders,
  responses,
  queuedMessages,
  interceptAccepted,
  resetHandlerRequestMocks,
  post,
} from './handler-request-fixture';

describe('Collector delivery retries', () => {
  beforeEach(resetHandlerRequestMocks);
  afterEach(() => vi.restoreAllMocks());

  it('reuses one receipt and original ciphertext after an uncertain Queue send', async () => {
    const queueSend = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue(undefined);
    const { env, deliveryObjects } = makeEnv({ creds: await validCredEntries(), queueSend });
    interceptAccepted();
    const body = JSON.stringify(envelope());
    expect((await post(env, body, authHeaders)).status).toBe(503);
    const original = new Map(deliveryObjects);
    vi.mocked(Date.now).mockReturnValue(TEST_NOW + 1000);
    expect((await post(env, body, authHeaders)).status).toBe(202);
    expect(queueSend.mock.calls[1]![0]).toEqual(queueSend.mock.calls[0]![0]);
    expect(deliveryObjects).toEqual(original);
    expect(env.AGENT_CONSUMER.registerDelivery).toHaveBeenCalledTimes(2);
  });

  it('reuses a completed receipt without resurrecting its deleted ciphertext', async () => {
    const { env, deliveryObjects, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptAccepted();
    const body = JSON.stringify(envelope());
    expect((await post(env, body, authHeaders)).status).toBe(202);
    const reference = (queueSend.mock.calls[0]![0] as { body: AgentDeliveryReference }[])[0]!.body;
    deliveryObjects.delete(reference.key);
    vi.mocked(Date.now).mockReturnValue(TEST_NOW + 1000);
    expect((await post(env, body, authHeaders)).status).toBe(202);
    expect(deliveryObjects.has(reference.key)).toBe(false);
    expect(queueSend.mock.calls[1]![0]).toEqual(queueSend.mock.calls[0]![0]);
  });

  it('concurrent duplicate requests publish the same delivery revision', async () => {
    const { env, deliveryObjects, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptAccepted();
    const body = JSON.stringify(envelope());
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => post(env, body, authHeaders)),
    );
    expect(responses.map(({ status }) => status)).toEqual([202, 202, 202, 202]);
    const deliveries = queueSend.mock.calls.map(([batch]) => batch);
    expect(deliveries).toEqual(Array(4).fill(deliveries[0]));
    expect(deliveryObjects.size).toBe(2);
  });

  it('discards recreated ciphertext when completion races the initial receipt lookup', async () => {
    let completed: AgentDeliveryStagedReference | null = null;
    let miss = false;
    const getDeliveryReceipt = vi.fn(async () => {
      if (miss) {
        miss = false;
        return null;
      }
      return completed;
    });
    const { env, deliveryObjects, queueSend } = makeEnv({
      creds: await validCredEntries(),
      getDeliveryReceipt,
    });
    interceptAccepted();
    const body = JSON.stringify(envelope());
    expect((await post(env, body, authHeaders)).status).toBe(202);
    expect(getDeliveryReceipt).toHaveBeenCalledTimes(2);
    const reference = (queueSend.mock.calls[0]![0] as { body: AgentDeliveryReference }[])[0]!.body;
    const { delivery_revision: _revision, ...original } = reference;
    completed = original;
    deliveryObjects.delete(reference.key);
    miss = true;
    vi.mocked(Date.now).mockReturnValue(TEST_NOW + 1000);
    expect((await post(env, body, authHeaders)).status).toBe(202);
    expect(getDeliveryReceipt).toHaveBeenCalledTimes(4);
    expect(deliveryObjects.has(reference.key)).toBe(false);
    expect(queueSend.mock.calls[1]![0]).toEqual(queueSend.mock.calls[0]![0]);
  });

  it('rejects conflicting reuse before another ownership claim or delivery publication', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptAccepted();
    const claim = vi.fn(responses.claim!);
    responses.claim = claim;
    expect((await post(env, JSON.stringify(envelope()), authHeaders)).status).toBe(202);
    const changed = envelope();
    changed.facts.messages[0]!.input_tokens += 1;
    const response = await post(env, JSON.stringify(changed), authHeaders);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'batch_identity_conflict' });
    expect(claim).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it('reuses staging after a failed registration instead of minting another delivery', async () => {
    const { env, deliveryObjects, queueSend } = makeEnv({ creds: await validCredEntries() });
    const register = env.AGENT_CONSUMER.registerDelivery;
    env.AGENT_CONSUMER.registerDelivery = vi
      .fn()
      .mockRejectedValueOnce(new Error('coordinator down'))
      .mockImplementation(register);
    interceptAccepted();
    const body = JSON.stringify(envelope());
    expect((await post(env, body, authHeaders)).status).toBe(503);
    const original = new Map(deliveryObjects);
    vi.mocked(Date.now).mockReturnValue(TEST_NOW + 1000);
    expect((await post(env, body, authHeaders)).status).toBe(202);
    expect(deliveryObjects).toEqual(original);
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it('assigns new content keys when ownership filtering changes a legitimate retry', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptAccepted();
    const body = JSON.stringify(
      envelope({
        facts: {
          ...emptyFacts(),
          messages: [
            messageFact({ vendor_session_id: 'first' }),
            messageFact({ vendor_session_id: 'second', vendor_message_id: 'second-message' }),
          ],
        },
      }),
    );
    expect((await post(env, body, authHeaders)).status).toBe(202);
    responses.claim = (_request, text) => {
      const claimed = JSON.parse(text) as { sessionPks: string[] };
      return Response.json({
        results: claimed.sessionPks.map((sessionPk, index) => ({
          sessionPk,
          status: index === 0 ? 'conflict' : 'claimed',
          ownerUserId: 'user-1',
        })),
      });
    };
    expect((await post(env, body, authHeaders)).status).toBe(202);
    const [first, second] = queueSend.mock.calls.map(
      ([batch]) => (batch as { body: AgentDeliveryReference }[])[0]!.body,
    );
    expect(second!.key).not.toBe(first!.key);
    expect(second!.delivery_revision).toBe(first!.delivery_revision + 1);
    const messages = await queuedMessages(queueSend, env.AGENT_DELIVERIES);
    expect(messages.map(({ facts }) => facts.messages.length)).toEqual([2, 1]);
  });

  it('reuses both delivery groups after an uncertain send of the later group', async () => {
    const queueSend = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second group response lost'))
      .mockResolvedValue(undefined);
    const { env, deliveryObjects } = makeEnv({ creds: await validCredEntries(), queueSend });
    const link = facts().pull_request_links[0]!;
    const links = Array.from({ length: 12 }, (_, index) => ({
      ...link,
      source_event_id: `event-${index}`,
      stable_turn_index: index,
      number: index + 1,
      url: `https://example.test/${index}/${'x'.repeat(70_000)}`,
    }));
    const body = JSON.stringify(envelope({ facts: facts({ pull_request_links: links }) }));
    interceptAccepted();
    expect((await post(env, body, authHeaders)).status).toBe(503);
    const original = new Map(deliveryObjects);
    vi.mocked(Date.now).mockReturnValue(TEST_NOW + 1000);
    expect((await post(env, body, authHeaders)).status).toBe(202);
    expect(queueSend).toHaveBeenCalledTimes(4);
    expect(queueSend.mock.calls[2]![0]).toEqual(queueSend.mock.calls[0]![0]);
    expect(queueSend.mock.calls[3]![0]).toEqual(queueSend.mock.calls[1]![0]);
    expect(deliveryObjects).toEqual(original);
  });

  it('does not reuse an accepted receipt after erasure closes admission', async () => {
    let admitted = true;
    const { env, queueSend } = makeEnv({
      creds: await validCredEntries(),
      canAcceptDeliveries: async () => admitted,
    });
    interceptAccepted();
    const body = JSON.stringify(envelope());
    expect((await post(env, body, authHeaders)).status).toBe(202);
    admitted = false;
    expect((await post(env, body, authHeaders)).status).toBe(503);
    expect(queueSend).toHaveBeenCalledOnce();
  });
});
