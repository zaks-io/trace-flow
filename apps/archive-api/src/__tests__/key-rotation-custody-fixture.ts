import { vi } from 'vitest';

export const ACTIVATION_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';

const CONVEX = 'https://archive-convex.test';

export class FakeArchiveCustody {
  readonly versions = new Map<number, string>();
  activeVersion = 1;
  retiringVersion?: number;
  operationId?: string;
  rotationStatus?: 'rotating' | 'succeeded' | 'failed';
  readonly destroyCalls: {
    keyVersion: number;
    liveReferenceCount: number;
    operationId: string;
  }[] = [];
  readonly keyFetches: number[] = [];
  readonly auditBodies: Record<string, unknown>[] = [];
  auditFailuresRemaining = 0;
  destroyFailuresRemaining = 0;

  handle(pathname: string, body: Record<string, unknown>): Response {
    if (pathname === '/archive-api/status') {
      return Response.json({ revision: body.revision ?? 1, replay: false });
    }
    if (pathname === '/archive-api/key/active') {
      const wrappedKey = this.versions.get(this.activeVersion);
      if (!wrappedKey) {
        return new Response(JSON.stringify({ error: 'Archive key unavailable' }), { status: 404 });
      }
      return Response.json({
        keyVersion: this.activeVersion,
        wrappedKey,
        activationId: ACTIVATION_ID,
        retiringKeyVersion: this.retiringVersion,
        rotationOperationId: this.operationId,
        rotationStatus: this.rotationStatus,
      });
    }
    if (pathname === '/archive-api/key/activate') {
      const keyVersion = body.keyVersion as number;
      const wrappedKey = body.wrappedKey as string;
      const operationId = body.operationId as string;
      if (this.operationId === operationId && this.activeVersion === keyVersion) {
        return Response.json({
          fromVersion: this.retiringVersion ?? keyVersion,
          toVersion: keyVersion,
          replay: true,
          operationId,
          activationId: ACTIVATION_ID,
        });
      }
      this.versions.set(keyVersion, wrappedKey);
      this.retiringVersion = this.activeVersion;
      this.activeVersion = keyVersion;
      this.operationId = operationId;
      this.rotationStatus = 'rotating';
      return Response.json({
        fromVersion: this.retiringVersion,
        toVersion: keyVersion,
        replay: false,
        operationId,
        activationId: ACTIVATION_ID,
      });
    }
    if (pathname === '/archive-api/key/destroy-retiring') {
      const liveReferenceCount = body.liveReferenceCount as number;
      const keyVersion = body.keyVersion as number;
      const operationId = body.operationId as string;
      this.destroyCalls.push({ keyVersion, liveReferenceCount, operationId });
      if (liveReferenceCount !== 0) {
        return Response.json(
          { error: 'Archive key still has live object references' },
          { status: 409 },
        );
      }
      if (this.destroyFailuresRemaining > 0) {
        this.destroyFailuresRemaining -= 1;
        return Response.json({ error: 'Archive key destroy unavailable' }, { status: 503 });
      }
      if (this.activeVersion === keyVersion) {
        return Response.json({ error: 'Active archive key cannot be destroyed' }, { status: 409 });
      }
      this.versions.delete(keyVersion);
      this.retiringVersion = undefined;
      this.rotationStatus = 'succeeded';
      return Response.json({ destroyed: true });
    }
    if (pathname === '/archive-api/key/rotation-failed') {
      if (this.operationId === body.operationId && this.rotationStatus !== 'succeeded') {
        this.rotationStatus = 'failed';
      }
      return Response.json({ recorded: true });
    }
    if (pathname === '/archive-api/key') {
      const keyVersion = body.keyVersion as number;
      this.keyFetches.push(keyVersion);
      const wrappedKey = this.versions.get(keyVersion);
      if (!wrappedKey) {
        return new Response(JSON.stringify({ error: 'Archive key unavailable' }), { status: 404 });
      }
      return Response.json({ keyVersion, wrappedKey });
    }
    if (pathname === '/archive-api/audit-events') {
      this.auditBodies.push(body);
      if (this.auditFailuresRemaining > 0) {
        this.auditFailuresRemaining -= 1;
        return Response.json({ error: 'temporary outage' }, { status: 503 });
      }
      return Response.json({ eventId: `audit-${this.auditBodies.length}`, created: true });
    }
    if (pathname === '/archive-api/authorize-write') {
      return Response.json({
        allowed: true,
        enrollmentId: 'enrollment-rotation',
        contributionId: body.contributionId ?? 'contribution-rotation',
        orgId: body.orgId,
        userId: body.userId,
        collectorId: 'collector-rotation',
        collectorCredentialId: 'cred-rotation',
      });
    }
    throw new Error(`unexpected convex path ${pathname}`);
  }
}

export function installCustody(custody: FakeArchiveCustody) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== CONVEX) {
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return custody.handle(url.pathname, body);
  });
}
