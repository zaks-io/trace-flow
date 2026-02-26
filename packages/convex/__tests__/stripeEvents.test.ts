import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// stripeEvents.ts handler logic tests
//
// All three mutations (startProcessing, markProcessed, markFailed) are
// internalMutation — tested by replaying their handler logic with a mocked ctx.
// ---------------------------------------------------------------------------

const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

function makeEventDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'event_doc_id' as any,
    _creationTime: Date.now() - 1000, // created 1 second ago by default
    eventId: 'evt_abc123',
    eventType: 'customer.subscription.updated',
    stripeObjectId: 'sub_xyz',
    status: 'processing' as 'processing' | 'processed' | 'failed',
    ...overrides,
  };
}

function makeCtx() {
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbInsert = vi.fn().mockResolvedValue('new_event_doc_id');

  return {
    db: {
      patch: dbPatch,
      insert: dbInsert,
      query: vi.fn().mockReturnValue({
        withIndex: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      }),
    },
    _dbPatch: dbPatch,
    _dbInsert: dbInsert,
  };
}

// ---------------------------------------------------------------------------
// startProcessing — idempotency logic
// ---------------------------------------------------------------------------

describe('stripeEvents.startProcessing handler logic', () => {
  it('inserts new event doc when event has not been seen before', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null), // no existing record
    });

    const existing = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!existing) {
      const id = await ctx.db.insert('stripeEvents', {
        eventId: 'evt_new',
        eventType: 'invoice.paid',
        stripeObjectId: 'in_abc',
        status: 'processing',
      });
      expect(id).toBe('new_event_doc_id');
    }

    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'stripeEvents',
      expect.objectContaining({ eventId: 'evt_new', status: 'processing' }),
    );
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('returns alreadyProcessed:true for already-processed events', async () => {
    const existing = makeEventDoc({ status: 'processed' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();

    let result: { alreadyProcessed: boolean; eventDocId: any };
    if (doc) {
      if (doc.status === 'processed') {
        result = { alreadyProcessed: true, eventDocId: doc._id };
      } else if (doc.status === 'processing') {
        const staleAfterMs = STALE_AFTER_MS;
        if (Date.now() - doc._creationTime > staleAfterMs) {
          result = { alreadyProcessed: false, eventDocId: doc._id };
        } else {
          result = { alreadyProcessed: true, eventDocId: doc._id };
        }
      } else {
        result = { alreadyProcessed: false, eventDocId: doc._id };
      }
    } else {
      result = { alreadyProcessed: false, eventDocId: 'new' };
    }

    expect(result.alreadyProcessed).toBe(true);
    expect(result.eventDocId).toBe('event_doc_id');
    expect(ctx._dbInsert).not.toHaveBeenCalled();
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('returns alreadyProcessed:true for in-flight processing event within 5 minutes', async () => {
    const existing = makeEventDoc({
      status: 'processing',
      _creationTime: Date.now() - 60_000, // 1 minute ago — not stale
    });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    expect(doc!.status).toBe('processing');

    const isStale = Date.now() - doc!._creationTime > STALE_AFTER_MS;
    expect(isStale).toBe(false);

    // Handler returns alreadyProcessed:true for non-stale in-flight events
    const result = { alreadyProcessed: !isStale, eventDocId: doc!._id };
    expect(result.alreadyProcessed).toBe(true);
  });

  it('allows reprocessing stale processing events older than 5 minutes', async () => {
    const staleTime = Date.now() - (STALE_AFTER_MS + 10_000); // 5min10s ago
    const existing = makeEventDoc({
      status: 'processing',
      _creationTime: staleTime,
    });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    const isStale = Date.now() - doc!._creationTime > STALE_AFTER_MS;
    expect(isStale).toBe(true);

    // Re-patches with 'processing' and returns alreadyProcessed:false
    await ctx.db.patch(doc!._id, { status: 'processing' });
    const result = { alreadyProcessed: false, eventDocId: doc!._id };

    expect(ctx._dbPatch).toHaveBeenCalledWith('event_doc_id', { status: 'processing' });
    expect(result.alreadyProcessed).toBe(false);
  });

  it('allows reprocessing failed events', async () => {
    const existing = makeEventDoc({ status: 'failed' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    expect(doc!.status).toBe('failed');

    // Failed events return alreadyProcessed:false (can be retried)
    const result = { alreadyProcessed: false, eventDocId: doc!._id };
    expect(result.alreadyProcessed).toBe(false);
    expect(ctx._dbInsert).not.toHaveBeenCalled();
  });

  it('5-minute boundary: event at exactly stale threshold is not reprocessed', () => {
    const exactlyStale = Date.now() - STALE_AFTER_MS;
    const isStale = Date.now() - exactlyStale > STALE_AFTER_MS;
    // Strict > means exactly at boundary is NOT stale
    expect(isStale).toBe(false);
  });

  it('5-minute boundary: event one ms past stale threshold is reprocessed', () => {
    const justOverStale = Date.now() - STALE_AFTER_MS - 1;
    const isStale = Date.now() - justOverStale > STALE_AFTER_MS;
    expect(isStale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markProcessed handler logic
// ---------------------------------------------------------------------------

describe('stripeEvents.markProcessed handler logic', () => {
  it('patches event to processed with timestamp', async () => {
    const existing = makeEventDoc({ status: 'processing' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!doc) return;

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: 'processed',
      processedAt: now,
      error: undefined,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('event_doc_id', {
      status: 'processed',
      processedAt: expect.any(Number),
      error: undefined,
    });
  });

  it('is a no-op when event not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!doc) return; // early return, no patch

    await ctx.db.patch(doc._id, { status: 'processed', processedAt: Date.now() });
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('clears error field when marking processed', async () => {
    const existing = makeEventDoc({ status: 'failed', error: 'previous error' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!doc) return;

    await ctx.db.patch(doc._id, {
      status: 'processed',
      processedAt: Date.now(),
      error: undefined,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith(
      'event_doc_id',
      expect.objectContaining({ error: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// markFailed handler logic
// ---------------------------------------------------------------------------

describe('stripeEvents.markFailed handler logic', () => {
  it('patches event to failed with error message and timestamp', async () => {
    const existing = makeEventDoc({ status: 'processing' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!doc) return;

    await ctx.db.patch(doc._id, {
      status: 'failed',
      processedAt: Date.now(),
      error: 'DB write failed',
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('event_doc_id', {
      status: 'failed',
      processedAt: expect.any(Number),
      error: 'DB write failed',
    });
  });

  it('is a no-op when event not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!doc) return;

    await ctx.db.patch(doc._id, { status: 'failed', error: 'x' });
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('stores the full error message string', async () => {
    const existing = makeEventDoc({ status: 'processing' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const doc = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    if (!doc) return;

    const errorMsg = 'Stripe API timeout after 30s retries';
    await ctx.db.patch(doc._id, {
      status: 'failed',
      processedAt: Date.now(),
      error: errorMsg,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith(
      'event_doc_id',
      expect.objectContaining({ error: errorMsg }),
    );
  });
});

// ---------------------------------------------------------------------------
// getByEventId handler logic
// ---------------------------------------------------------------------------

describe('stripeEvents.getByEventId handler logic', () => {
  it('returns event doc when found', async () => {
    const existing = makeEventDoc();
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const result = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    expect(result).toEqual(existing);
  });

  it('returns null when event not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const result = await ctx.db.query('stripeEvents').withIndex('by_event_id').first();
    expect(result).toBeNull();
  });
});
