import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_INTEGRITY_ERROR_CLASSES } from '@trace-flow/types';
import { createApp, type HttpDeps } from '../http';
import { captureConsoleLogs, createMockCtx, createMockDeps, type MockCtx } from './httpTest.setup';

describe('convex/http.ts internal routes', () => {
  let ctx: MockCtx;
  let deps: HttpDeps;

  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
    ctx = createMockCtx();
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe('POST /usage/record', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';

    it('records usage when trace context is provided', async () => {
      vi.stubEnv('USAGE_SYNC_SECRET', 'sync-secret');
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({ _id: ORG_ID });
      ctx.runMutation.mockResolvedValue(undefined);

      const res = await app.request(
        'http://localhost/usage/record',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer sync-secret',
            traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
          },
          body: JSON.stringify({
            orgId: ORG_ID,
            periodStart: 1,
            periodEnd: 2,
            subscriptionUnitsUsed: 3,
            addonUnitsUsed: 4,
            traceContext: {
              traceId: '0123456789abcdef0123456789abcdef',
              requestId: 'req_123',
            },
          }),
        },
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runQuery).toHaveBeenCalledOnce();
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
      expect(ctx.runMutation.mock.calls[0]?.[1]).toMatchObject({
        orgId: ORG_ID,
        periodStart: 1,
        periodEnd: 2,
        subscriptionUnitsUsed: 3,
        addonUnitsUsed: 4,
      });
      expect(ctx.runMutation.mock.calls[1]?.[1]).toMatchObject({
        orgId: ORG_ID,
        subscriptionUnitsUsed: 3,
        addonUnitsUsed: 4,
      });
    });

    it('rejects malformed org ids before Convex validators run', async () => {
      vi.stubEnv('USAGE_SYNC_SECRET', 'sync-secret');
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/usage/record',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer sync-secret',
          },
          body: JSON.stringify({
            orgId: 'org_dev_smoke',
            periodStart: 1,
            periodEnd: 2,
            subscriptionUnitsUsed: 3,
            addonUnitsUsed: 4,
          }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid organization id' });
      expect(ctx.runQuery).not.toHaveBeenCalled();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });
  });

  describe('POST /agent-ingest/claim-sessions', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
    const USER_ID = 'j57axc8sefsfp6k28nx6c481js806pwv';

    beforeEach(() => {
      vi.stubEnv('AGENT_INGEST_SHARED_SECRET', 'agent-secret');
    });

    it('rejects malformed org ids before Convex validators run', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/agent-ingest/claim-sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer agent-secret',
          },
          body: JSON.stringify({
            orgId: 'org_dev_smoke',
            userId: USER_ID,
            collectorId: 'collector-1',
            sessionPks: ['session-1'],
          }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid organization id' });
      expect(ctx.runQuery).not.toHaveBeenCalled();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('rejects malformed user ids before Convex validators run', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValueOnce({ _id: ORG_ID });

      const res = await app.request(
        'http://localhost/agent-ingest/claim-sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer agent-secret',
          },
          body: JSON.stringify({
            orgId: ORG_ID,
            userId: 'user_dev_smoke',
            collectorId: 'collector-1',
            sessionPks: ['session-1'],
          }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid user id' });
      expect(ctx.runQuery).toHaveBeenCalledOnce();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });
  });

  describe('POST /archive-api/authorize-write', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
    const USER_ID = 'j57axc8sefsfp6k28nx6c481js806pwv';

    beforeEach(() => {
      vi.stubEnv('ARCHIVE_API_SHARED_SECRET', 'archive-secret');
    });

    it('rejects a missing shared secret', async () => {
      const logs = captureConsoleLogs();
      try {
        const app = createApp(deps);
        const res = await app.request(
          'http://localhost/archive-api/authorize-write',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hashedSecret: 'hash-owner',
              source: 'claude',
              orgId: ORG_ID,
              userId: USER_ID,
              collectorId: 'collector-owner',
            }),
          },
          ctx,
        );
        expect(res.status).toBe(401);
        expect(ctx.runQuery).not.toHaveBeenCalled();
        expect(logs.text()).toContain('convex.archive_authorize_shared_secret_invalid');
        expect(logs.text()).toContain('"reason":"missing"');
      } finally {
        logs.restore();
      }
    });

    it('rejects a Pipe Token bearer that is not the Archive API shared secret', async () => {
      const probe = 'pipe-token-must-never-enter-logs';
      const logs = captureConsoleLogs();
      try {
        const app = createApp(deps);
        const res = await app.request(
          'http://localhost/archive-api/authorize-write',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${probe}`,
            },
            body: JSON.stringify({
              hashedSecret: 'hash-owner',
              source: 'claude',
              orgId: ORG_ID,
              userId: USER_ID,
              collectorId: 'collector-owner',
            }),
          },
          ctx,
        );
        expect(res.status).toBe(401);
        expect(ctx.runQuery).not.toHaveBeenCalled();
        expect(logs.text()).toContain('convex.archive_authorize_shared_secret_invalid');
        expect(logs.text()).toContain('"reason":"invalid"');
        expect(logs.text()).not.toContain(probe);
        expect(logs.text()).not.toContain(`Bearer ${probe}`);
      } finally {
        logs.restore();
      }
    });

    it('rejects malformed organization ids before Convex validators run', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/archive-api/authorize-write',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({
            hashedSecret: 'hash-owner',
            source: 'claude',
            orgId: 'org_dev_smoke',
            userId: USER_ID,
            collectorId: 'collector-owner',
          }),
        },
        ctx,
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid organization id' });
      expect(ctx.runQuery).not.toHaveBeenCalled();
    });

    it('forwards a valid request to the hashed-secret authorize query', async () => {
      ctx.runQuery.mockResolvedValueOnce({
        allowed: false,
        reason: 'not_enrolled',
      });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/archive-api/authorize-write',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({
            hashedSecret: 'hash-owner',
            source: 'claude',
            orgId: ORG_ID,
            userId: USER_ID,
            collectorId: 'collector-owner',
          }),
        },
        ctx,
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ allowed: false, reason: 'not_enrolled' });
      expect(ctx.runQuery).toHaveBeenCalledOnce();
      const queryArgs = ctx.runQuery.mock.calls[0]?.[1] as {
        hashedSecret: string;
        source: string;
        orgId: string;
        userId: string;
        collectorId: string;
        now: number;
      };
      expect(queryArgs).toMatchObject({
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: ORG_ID,
        userId: USER_ID,
        collectorId: 'collector-owner',
      });
      expect(queryArgs.now).toBeGreaterThan(0);
    });
  });

  describe('POST /archive-api/audit-events', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
    const ENROLLMENT_ID = 'm57axc8sefsfp6k28nx6c481js806pwv';

    beforeEach(() => {
      vi.stubEnv('ARCHIVE_API_SHARED_SECRET', 'archive-secret');
    });

    it('rejects a missing shared secret', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/archive-api/audit-events',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
            action: 'export_completed',
            outcome: 'success',
            operationId: 'export:1',
          }),
        },
        ctx,
      );
      expect(res.status).toBe(401);
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('rejects caller-supplied actor or tenant substitution', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/archive-api/audit-events',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({
            binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
            action: 'export_completed',
            outcome: 'success',
            operationId: 'export:1',
            actorUserId: 'j57axc8sefsfp6k28nx6c481js806pwv',
            orgId: ORG_ID,
          }),
        },
        ctx,
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Caller-supplied actor or tenant substitution is not allowed',
      });
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('rejects transcript fields and per-chunk event types', async () => {
      const app = createApp(deps);
      const transcript = await app.request(
        'http://localhost/archive-api/audit-events',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({
            binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
            action: 'export_completed',
            outcome: 'success',
            operationId: 'export:1',
            transcript: 'user said hello',
          }),
        },
        ctx,
      );
      expect(transcript.status).toBe(400);
      await expect(transcript.json()).resolves.toEqual({
        error: 'Archive audit events cannot store transcript',
      });

      const chunk = await app.request(
        'http://localhost/archive-api/audit-events',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({
            binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
            action: 'chunk_upload',
            outcome: 'success',
            operationId: 'chunk:1',
          }),
        },
        ctx,
      );
      expect(chunk.status).toBe(400);
      await expect(chunk.json()).resolves.toEqual({
        error: 'Per-chunk archive audit events are not recorded',
      });
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('logs and rejects malformed and non-object JSON before forwarding', async () => {
      const logs = captureConsoleLogs();
      try {
        const app = createApp(deps);
        const malformed = await app.request(
          'http://localhost/archive-api/audit-events',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer archive-secret',
            },
            body: '{not-json',
          },
          ctx,
        );
        expect(malformed.status).toBe(400);
        await expect(malformed.json()).resolves.toEqual({ error: 'Invalid audit event' });
        expect(logs.text()).toContain('convex.archive_audit_rejected');
        expect(logs.text()).toContain('"reason":"malformed_json"');

        const nonObject = await app.request(
          'http://localhost/archive-api/audit-events',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer archive-secret',
            },
            body: JSON.stringify(['export_completed']),
          },
          ctx,
        );
        expect(nonObject.status).toBe(400);
        await expect(nonObject.json()).resolves.toEqual({ error: 'Invalid audit event' });
        expect(logs.text()).toContain('"reason":"non_object_json"');
        expect(ctx.runMutation).not.toHaveBeenCalled();
      } finally {
        logs.restore();
      }
    });

    it('forwards a valid semantic event without trusting caller actor or time', async () => {
      ctx.runMutation.mockResolvedValueOnce({ eventId: 'event-1', created: true });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/archive-api/audit-events',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({
            binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
            expectedOrgId: ORG_ID,
            action: 'key_rotation',
            outcome: 'success',
            operationId: 'rotate:1',
            targetKind: 'encryption_key',
            targetId: 'key-v2',
            relevantCount: 4,
          }),
        },
        ctx,
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ eventId: 'event-1', created: true });
      expect(ctx.runMutation).toHaveBeenCalledOnce();
      expect(ctx.runMutation.mock.calls[0]?.[1]).toEqual({
        binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
        expectedOrgId: ORG_ID,
        action: 'key_rotation',
        outcome: 'success',
        operationId: 'rotate:1',
        targetKind: 'encryption_key',
        targetId: 'key-v2',
        relevantCount: 4,
        manifestRootHash: undefined,
        source: undefined,
        sourceSessionId: undefined,
      });
    });
  });

  describe('POST /archive-api/session-integrity', () => {
    const COLLECTOR_CREDENTIAL_ID = 'n57axc8sefsfp6k28nx6c481js806pwv';

    beforeEach(() => {
      vi.stubEnv('ARCHIVE_API_SHARED_SECRET', 'archive-secret');
    });

    it('requires the shared secret and never logs the supplied credential', async () => {
      const probe = 'integrity-route-secret-probe';
      const logs = captureConsoleLogs();
      try {
        const res = await createApp(deps).request(
          'http://localhost/archive-api/session-integrity',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${probe}` },
            body: JSON.stringify({
              collectorCredentialId: COLLECTOR_CREDENTIAL_ID,
              source: 'codex',
              sourceSessionId: 'session-1',
              errorClass: 'payload_hash_mismatch',
            }),
          },
          ctx,
        );
        expect(res.status).toBe(401);
        expect(ctx.runMutation).not.toHaveBeenCalled();
        expect(logs.text()).not.toContain(probe);
      } finally {
        logs.restore();
      }
    });

    it('forwards a document id once and rejects a credential hash', async () => {
      ctx.runMutation.mockResolvedValueOnce({
        contributionId: 'contribution-1',
        source: 'codex',
        sourceSessionId: 'session-1',
        errorClass: 'payload_hash_mismatch',
        updatedAt: 123,
      });
      const res = await createApp(deps).request(
        'http://localhost/archive-api/session-integrity',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer archive-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            collectorCredentialId: COLLECTOR_CREDENTIAL_ID,
            source: 'codex',
            sourceSessionId: 'session-1',
            errorClass: 'payload_hash_mismatch',
            payload: 'must-not-forward',
            path: '/must/not/forward',
            secret: 'must-not-forward',
          }),
        },
        ctx,
      );
      expect(res.status).toBe(200);
      expect(ctx.runMutation).toHaveBeenCalledOnce();
      expect(ctx.runMutation.mock.calls[0]?.[1]).toEqual({
        collectorCredentialId: COLLECTOR_CREDENTIAL_ID,
        source: 'codex',
        sourceSessionId: 'session-1',
        errorClass: 'payload_hash_mismatch',
      });
      expect(JSON.stringify(ctx.runMutation.mock.calls[0]?.[1])).not.toContain('must-not-forward');

      const hashResponse = await createApp(deps).request(
        'http://localhost/archive-api/session-integrity',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer archive-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            collectorCredentialId: 'a'.repeat(64),
            source: 'codex',
            sourceSessionId: 'session-1',
            errorClass: 'payload_hash_mismatch',
          }),
        },
        ctx,
      );
      expect(hashResponse.status).toBe(400);
      expect(ctx.runMutation).toHaveBeenCalledOnce();
    });

    it.each([
      '',
      '.',
      '..',
      '/tmp/transcript.jsonl',
      '\\tmp\\transcript.jsonl',
      'C:transcript.jsonl',
      'session\nnear-miss',
      'session\u007fnear-miss',
      'session\ud800',
      'x'.repeat(1025),
    ])('rejects noncanonical source session metadata %#', async (sourceSessionId) => {
      const res = await createApp(deps).request(
        'http://localhost/archive-api/session-integrity',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer archive-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            collectorCredentialId: COLLECTOR_CREDENTIAL_ID,
            source: 'claude',
            sourceSessionId,
            errorClass: 'payload_hash_mismatch',
          }),
        },
        ctx,
      );
      expect(res.status).toBe(400);
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('accepts every canonical error class and rejects arbitrary near-misses', async () => {
      for (const errorClass of ARCHIVE_INTEGRITY_ERROR_CLASSES) {
        ctx.runMutation.mockResolvedValueOnce({
          contributionId: 'contribution-1',
          source: 'claude',
          sourceSessionId: 'session-1',
          errorClass,
          updatedAt: 123,
        });
        const response = await createApp(deps).request(
          'http://localhost/archive-api/session-integrity',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer archive-secret',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              collectorCredentialId: COLLECTOR_CREDENTIAL_ID,
              source: 'claude',
              sourceSessionId: 'session-1',
              errorClass,
            }),
          },
          ctx,
        );
        expect(response.status, errorClass).toBe(200);
      }

      for (const errorClass of [
        'arbitrary_integrity_failure',
        'payload_hash_mismatch_extra',
        'Payload_hash_mismatch',
      ]) {
        const response = await createApp(deps).request(
          'http://localhost/archive-api/session-integrity',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer archive-secret',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              collectorCredentialId: COLLECTOR_CREDENTIAL_ID,
              source: 'claude',
              sourceSessionId: 'session-1',
              errorClass,
            }),
          },
          ctx,
        );
        expect(response.status, errorClass).toBe(400);
      }
      expect(ctx.runMutation).toHaveBeenCalledTimes(ARCHIVE_INTEGRITY_ERROR_CLASSES.length);
    });
  });

  describe('POST /archive-api/key', () => {
    beforeEach(() => {
      vi.stubEnv('ARCHIVE_API_SHARED_SECRET', 'archive-secret');
    });

    it('returns the requested wrapped organization key version', async () => {
      ctx.runQuery.mockResolvedValueOnce({ keyVersion: 7, wrappedKey: 'wrapped-test-value' });
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/archive-api/key',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer archive-secret',
          },
          body: JSON.stringify({ orgId: 'k57axc8sefsfp6k28nx6c481js806pwv', keyVersion: 7 }),
        },
        ctx,
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        keyVersion: 7,
        wrappedKey: 'wrapped-test-value',
      });
      expect(ctx.runQuery).toHaveBeenCalledOnce();
      expect(ctx.runQuery.mock.calls[0]?.[1]).toEqual({
        orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
        keyVersion: 7,
      });
    });

    it('rejects requests without the Archive API shared secret before the key query', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/archive-api/key',
        {
          method: 'POST',
          body: JSON.stringify({ orgId: 'k57axc8sefsfp6k28nx6c481js806pwv', keyVersion: 7 }),
        },
        ctx,
      );

      expect(res.status).toBe(401);
      expect(ctx.runQuery).not.toHaveBeenCalled();
    });
  });

  describe('POST /archive-api/status', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
    const PROBE = 'status-probe-secret-must-not-be-logged';

    beforeEach(() => {
      vi.stubEnv('ARCHIVE_API_SHARED_SECRET', 'archive-secret');
    });

    it('requires the shared secret without logging the supplied credential', async () => {
      const logs = captureConsoleLogs();
      try {
        const app = createApp(deps);
        const res = await app.request(
          'http://localhost/archive-api/status',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${PROBE}` },
            body: JSON.stringify({ orgId: ORG_ID, revision: 1, storedBytes: 3 }),
          },
          ctx,
        );
        expect(res.status).toBe(401);
        expect(ctx.runMutation).not.toHaveBeenCalled();
        expect(logs.text()).not.toContain(PROBE);
      } finally {
        logs.restore();
      }
    });

    it('validates metadata and forwards no plaintext or credential fields', async () => {
      const app = createApp(deps);
      const malformed = await app.request(
        'http://localhost/archive-api/status',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer archive-secret' },
          body: JSON.stringify({ orgId: ORG_ID, revision: 1, storedBytes: -1 }),
        },
        ctx,
      );
      expect(malformed.status).toBe(400);
      expect(ctx.runMutation).not.toHaveBeenCalled();

      ctx.runMutation.mockResolvedValueOnce({ revision: 4, replay: false });
      const res = await app.request(
        'http://localhost/archive-api/status',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer archive-secret' },
          body: JSON.stringify({
            orgId: ORG_ID,
            revision: 4,
            storedBytes: 17,
            lifecycle: 'blocked',
            plaintext: 'must-not-forward',
            ciphertext: 'must-not-forward',
            collectorSecret: PROBE,
          }),
        },
        ctx,
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ revision: 4, replay: false });
      expect(ctx.runMutation).toHaveBeenCalledOnce();
      expect(ctx.runMutation.mock.calls[0]?.[1]).toEqual({
        orgId: ORG_ID,
        revision: 4,
        storedBytes: 17,
        lastDurableAcknowledgedAt: undefined,
        lifecycle: 'blocked',
      });
      expect(JSON.stringify(ctx.runMutation.mock.calls[0]?.[1])).not.toContain('must-not-forward');
    });

    it('returns replay success and explicit revision conflicts for retry and stale paths', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValueOnce({ revision: 4, replay: true });
      const replay = await app.request(
        'http://localhost/archive-api/status',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer archive-secret' },
          body: JSON.stringify({ orgId: ORG_ID, revision: 4, storedBytes: 17 }),
        },
        ctx,
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual({ revision: 4, replay: true });

      for (const message of [
        'Stale archive server status revision',
        'Archive server status revision was reused with a different payload',
      ]) {
        ctx.runMutation.mockRejectedValueOnce(new Error(message));
        const conflict = await app.request(
          'http://localhost/archive-api/status',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer archive-secret' },
            body: JSON.stringify({ orgId: ORG_ID, revision: 4, storedBytes: 17 }),
          },
          ctx,
        );
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toEqual({
          error: 'Archive status revision conflict',
        });
      }
    });
  });
});
