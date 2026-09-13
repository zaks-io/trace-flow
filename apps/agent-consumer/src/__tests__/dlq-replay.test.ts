import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import type * as Consumer from '../consumer';
import type { AgentConsumerEnv } from '../context';
import { TraceRecovery } from '../index';
import { queueMessage } from './factories';

const processAgentRecoveryPayload = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../consumer', async (importOriginal) => ({
  ...(await importOriginal<typeof Consumer>()),
  processAgentRecoveryPayload,
}));

import { replayAgentDlqPayload } from '../dlq-replay';

const ROOT_KEY = btoa('a'.repeat(32));

afterEach(() => {
  vi.restoreAllMocks();
  processAgentRecoveryPayload.mockClear();
});

describe('DLQ delivery replay', () => {
  it('keeps nonmigrated organizations on the legacy recovery path', async () => {
    const body = queueMessage();
    const { env, put, register, process, migrationState } = makeEnv({
      migrationId: null,
      migrationComplete: false,
    });

    await replayAgentDlqPayload(body, env);

    expect(processAgentRecoveryPayload).toHaveBeenCalledWith(body, env);
    expect(migrationState).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('waits for a complete migrated delivery before returning', async () => {
    let finishProcess!: () => void;
    const processGate = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    const order: string[] = [];
    const process = vi.fn(async () => {
      order.push('process');
      await processGate;
    });
    const { env, put, register } = makeEnv({
      process,
      onPut: () => order.push('put'),
      onRegister: () => order.push('register'),
    });

    let settled = false;
    const running = replayAgentDlqPayload(queueMessage(), env).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    expect(processAgentRecoveryPayload).not.toHaveBeenCalled();
    expect(order).toEqual(['put', 'register', 'process']);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent-delivery', org_id: 'org-1' }),
      ['2026-05-20'],
    );
    expect(put).toHaveBeenCalledOnce();

    finishProcess();
    await running;
    expect(settled).toBe(true);
  });

  it('does not fall back to the frozen ledger before baseline migration completes', async () => {
    const { env, put, register, process } = makeEnv({ migrationComplete: false });

    await expect(replayAgentDlqPayload(queueMessage(), env)).rejects.toThrow(
      'baseline migration is incomplete',
    );
    expect(processAgentRecoveryPayload).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('does not resolve the source record when migrated delivery confirmation fails', async () => {
    const process = vi.fn(async () => {
      throw new Error('canonical write unavailable');
    });
    const { env, factBatcherGetByName, legacyState } = makeEnv({ process });
    const record = {
      id: 42,
      kind: 'dlq',
      state: 'blocked',
      payload: JSON.stringify({ body: queueMessage() }),
    };
    const resolveDlq = vi.fn();
    const source = {
      assertFactMaintenanceUnlocked: vi.fn(async () => undefined),
      getRecovery: vi.fn(async () => record),
      resolveDlq,
    };
    factBatcherGetByName.mockImplementation((name) =>
      name === 'org:__dlq__' ? source : { getIngestionMigrationState: legacyState },
    );
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', { recoveryId: record.id, reason: 'retry after recovery' }),
    ).rejects.toThrow('canonical write unavailable');

    expect(process).toHaveBeenCalledOnce();
    expect(resolveDlq).not.toHaveBeenCalled();
  });
});

function makeEnv(
  options: {
    migrationId?: string | null;
    migrationComplete?: boolean;
    process?: ReturnType<typeof vi.fn>;
    onPut?: () => void;
    onRegister?: () => void;
  } = {},
) {
  const legacyState = vi.fn(async () => ({
    migrationId:
      options.migrationId === undefined ? 'bounded-agent-ingestion-v1' : options.migrationId,
  }));
  const migrationState = vi.fn(async () => ({
    proofSha256: 'a'.repeat(64),
    complete: options.migrationComplete ?? true,
  }));
  const getErasureState = vi.fn(async () => null);
  const put = vi.fn(async (key: string) => {
    options.onPut?.();
    return { key };
  });
  const register = vi.fn(async () => {
    options.onRegister?.();
    return 7;
  });
  const process = options.process ?? vi.fn(async () => undefined);
  const factBatcherGetByName = vi.fn((_name: string): unknown => ({
    getIngestionMigrationState: legacyState,
  }));
  const env = {
    AGENT_FACT_BATCHER: {
      getByName: factBatcherGetByName,
    },
    AGENT_DELIVERY_COORDINATOR: {
      getByName: vi.fn(() => ({ getErasureState, getIngestionMigrationState: migrationState })),
    },
    AGENT_DELIVERY: { getByName: vi.fn(() => ({ register, process })) },
    AGENT_DELIVERIES: { put },
    BODY_ENCRYPTION_ROOT_KEY: ROOT_KEY,
  } as unknown as AgentConsumerEnv;
  return {
    env,
    factBatcherGetByName,
    legacyState,
    migrationState,
    process,
    put,
    register,
  };
}
