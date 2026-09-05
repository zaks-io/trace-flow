import { describe, expect, it } from 'vitest';
import { internal } from '../_generated/api';
import {
  enableArchive,
  enrollInput,
  seedWorld,
} from './archiveControlPlaneTest.setup';

describe('archive desktop control-plane helpers', () => {
  it('lets an owner activate and enroll as distinct records', async () => {
    enableArchive();
    const world = await seedWorld();
    const activated = await world.t.mutation(internal.archiveDesktop.activateForUser, {
      userId: world.owner._id,
    });
    expect(activated.created).toBe(true);
    const enrolled = await world.t.mutation(internal.archiveDesktop.enrollForUser, {
      userId: world.owner._id,
      collectorId: 'collector-owner',
      authorizedSources: enrollInput(world.ownerCred).authorizedSources,
      idempotencyKey: 'consent:collector-owner:new_only:1',
    });
    expect(enrolled.created).toBe(true);
    expect(enrolled.enrollmentId).not.toBe(activated.activationId);
    const snapshot = await world.t.query(internal.archiveDesktop.snapshotForUser, {
      userId: world.owner._id,
      collectorId: 'collector-owner',
    });
    expect(snapshot.role).toBe('owner');
    expect(snapshot.activation).toBe('active');
    expect(snapshot.enrollmentStatus).toBe('active');
  });

  it('blocks a member from activating or enrolling another user collector', async () => {
    enableArchive();
    const world = await seedWorld();
    await expect(
      world.t.mutation(internal.archiveDesktop.activateForUser, { userId: world.member._id }),
    ).rejects.toThrow('Only the organization owner can activate Conversation Archive');

    await world.t.mutation(internal.archiveDesktop.activateForUser, { userId: world.owner._id });
    await expect(
      world.t.mutation(internal.archiveDesktop.enrollForUser, {
        userId: world.member._id,
        collectorId: 'collector-owner',
        authorizedSources: enrollInput(world.memberCred).authorizedSources,
        idempotencyKey: 'consent:stolen:new_only:1',
      }),
    ).rejects.toThrow('Collector Credential not found');

    const enrolled = await world.t.mutation(internal.archiveDesktop.enrollForUser, {
      userId: world.member._id,
      collectorId: 'collector-member',
      authorizedSources: enrollInput(world.memberCred).authorizedSources,
      idempotencyKey: 'consent:collector-member:new_only:1',
    });
    expect(enrolled.created).toBe(true);
  });

  it('rejects hobby and canceled Pro', async () => {
    enableArchive();
    const hobby = await seedWorld('hobby');
    await expect(
      hobby.t.mutation(internal.archiveDesktop.activateForUser, { userId: hobby.owner._id }),
    ).rejects.toThrow('Active Pro entitlement is required');

    const canceled = await seedWorld('pro', 'canceled');
    await expect(
      canceled.t.mutation(internal.archiveDesktop.activateForUser, { userId: canceled.owner._id }),
    ).rejects.toThrow('Active Pro entitlement is required');
  });
});
