import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerLogger } from '@trace-flow/logging';
import {
  appendArchiveAuditEvent,
  assertArchiveAuditRequest,
  type ArchiveAuditAppendRequest,
} from '../audit';
import type { ArchiveApiEnv } from '../context';

const CONVEX = 'https://convex.test';
const SHARED = 'archive-shared-secret';
const ENROLLMENT_ID = 'm57axc8sefsfp6k28nx6c481js806pwv';
const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';

function makeEnv(): Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'> {
  return {
    CONVEX_SITE_URL: CONVEX,
    ARCHIVE_API_SHARED_SECRET: SHARED,
  };
}

function logger() {
  return createWorkerLogger({
    service: 'archive-api',
    request: new Request('https://archive.test/audit'),
    context: { component: 'test', operation: 'audit' },
  });
}

function validRequest(over: Partial<ArchiveAuditAppendRequest> = {}): ArchiveAuditAppendRequest {
  return {
    binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
    expectedOrgId: ORG_ID,
    action: 'export_completed',
    outcome: 'success',
    operationId: 'export:1',
    ...over,
  };
}

describe('Archive API audit client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses transcript, actor, tenant, and per-chunk fields before calling Convex', () => {
    expect(() =>
      assertArchiveAuditRequest({
        ...validRequest(),
        transcript: 'hello',
      } as ArchiveAuditAppendRequest),
    ).toThrow('not allowed');
    expect(() =>
      assertArchiveAuditRequest({
        ...validRequest(),
        actorUserId: 'j57axc8sefsfp6k28nx6c481js806pwv',
      } as ArchiveAuditAppendRequest),
    ).toThrow('not allowed');
    expect(() =>
      assertArchiveAuditRequest({
        ...validRequest(),
        action: 'chunk_upload',
      } as unknown as ArchiveAuditAppendRequest),
    ).toThrow('Per-chunk');
    expect(() =>
      assertArchiveAuditRequest({
        ...validRequest(),
        action: 'not-real',
      } as unknown as ArchiveAuditAppendRequest),
    ).toThrow('Unknown archive audit event type');
  });

  it('posts only metadata through the authenticated internal Convex seam', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ eventId: 'event-1', created: true }), { status: 200 }),
      );

    const result = await appendArchiveAuditEvent(makeEnv(), validRequest(), logger());
    expect(result).toEqual({ eventId: 'event-1', created: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [input, init] = fetchMock.mock.calls[0]!;
    const req = new Request(input, init);
    expect(req.url).toBe(`${CONVEX}/archive-api/audit-events`);
    expect(req.headers.get('Authorization')).toBe(`Bearer ${SHARED}`);
    const body: unknown = await req.json();
    expect(body).toEqual({
      binding: { kind: 'enrollment', enrollmentId: ENROLLMENT_ID },
      expectedOrgId: ORG_ID,
      action: 'export_completed',
      outcome: 'success',
      operationId: 'export:1',
    });
    expect(body).not.toHaveProperty('actor');
    expect(body).not.toHaveProperty('actorUserId');
    expect(body).not.toHaveProperty('orgId');
    expect(body).not.toHaveProperty('occurredAt');
    expect(body).not.toHaveProperty('transcript');
  });

  it('does not mint a per-chunk upload or download event', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(
      appendArchiveAuditEvent(
        makeEnv(),
        validRequest({
          action: 'chunk_download' as unknown as ArchiveAuditAppendRequest['action'],
        }),
        logger(),
      ),
    ).rejects.toThrow('Per-chunk');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
