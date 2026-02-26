# Subscriptions Test Plan

Test blueprint for `packages/convex/subscriptions.ts` (~950 lines) and its integration points in `packages/convex/http.ts` (webhook handler) and `packages/convex/usage.ts` (auto-topup trigger).

## Mocking Strategy

Follow the pattern established in `packages/convex/__tests__/http.test.ts`:

```ts
interface MockCtx {
  db: { query: Mock; get: Mock; patch: Mock; insert: Mock };
  scheduler: { runAfter: Mock; cancel: Mock };
  auth: { getUserIdentity: Mock };
  runQuery: Mock;
  runMutation: Mock;
  runAction: Mock;
}
```

### What to mock

| Dependency                                    | How to mock                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.db` (queries, patches, inserts)          | `vi.fn()` with chained `.query().withIndex().first()` / `.collect()` pattern                                                                                                                                                                                                                                                                                                                                 |
| `ctx.scheduler`                               | `vi.fn()` for `runAfter` and `cancel`                                                                                                                                                                                                                                                                                                                                                                        |
| `ctx.auth`                                    | `vi.fn()` returning mock identity with `tokenIdentifier` and `neuron/roles`                                                                                                                                                                                                                                                                                                                                  |
| `requireTraceFlowRole` / `requireEnabledUser` | Mock or spy; for unit tests, stub to resolve                                                                                                                                                                                                                                                                                                                                                                 |
| `Stripe` client                               | Mock the module -- `getStripeClient()` reads `process.env.STRIPE_SECRET_KEY` at module scope. Use `vi.stubEnv()` + mock the Stripe constructor. Mock methods: `customers.create`, `checkout.sessions.create`, `subscriptions.update`, `subscriptions.retrieve`, `billingPortal.sessions.create`, `invoiceItems.create`, `invoices.create`, `invoices.pay`, `invoicePayments.list`, `webhooks.constructEvent` |
| `internal.*` references                       | When testing actions that call `ctx.runQuery`/`ctx.runMutation`, mock those calls and assert the args                                                                                                                                                                                                                                                                                                        |
| `TIER_CONFIG`                                 | Import directly from `@trace-flow/types` -- no mock needed                                                                                                                                                                                                                                                                                                                                                   |

### Mock factory for subscription documents

Create a `createMockSubscription(overrides)` factory returning a valid subscription document with sensible defaults:

```ts
function createMockSubscription(overrides = {}) {
  return {
    _id: 'sub_123' as Id<'subscriptions'>,
    orgId: 'org_123' as Id<'organizations'>,
    tier: 'pro',
    status: 'active',
    monthlyUnits: 100_000,
    addonUnits: 0,
    seatQuantity: 1,
    currentPeriodStart: Date.now() - 15 * 86400000,
    currentPeriodEnd: Date.now() + 15 * 86400000,
    currentPeriodOverageSpentCents: 0,
    addonPurchaseCount: 0,
    autoOverage: false,
    ...overrides,
  };
}
```

---

## Pure Functions (no mocks needed)

### `findSubscriptionItems(items)`

| Scenario                                | Input                                                            | Expected                                       |
| --------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Matches plan and seat by price ID       | Items with matching pro/seat price IDs                           | `{ planItem, seatItem }` both set              |
| Only plan item matches                  | One item matching pro price ID                                   | `{ planItem, seatItem: undefined }`            |
| Only seat item matches                  | One item matching seat price ID                                  | `{ planItem: undefined, seatItem }`            |
| No price ID match, single item (legacy) | One item, unknown price ID                                       | `{ planItem: items[0], seatItem: undefined }`  |
| No match, multiple items                | Two items, neither matches                                       | `{ planItem: undefined, seatItem: undefined }` |
| Empty items array                       | `[]`                                                             | `{ planItem: undefined, seatItem: undefined }` |
| Price as string vs object               | `item.price = "price_123"` vs `item.price = { id: "price_123" }` | Same result                                    |

### `mapStripeStatusToInternal(status)`

| Stripe Status        | Expected       |
| -------------------- | -------------- |
| `active`             | `active`       |
| `trialing`           | `active`       |
| `past_due`           | `grace`        |
| `incomplete`         | `suspended`    |
| `unpaid`             | `suspended`    |
| `canceled`           | `canceled`     |
| `incomplete_expired` | `canceled`     |
| Unknown string       | Throws `Error` |

---

## Internal Mutations

### `setTier`

**Happy paths:**

- Upgrade hobby -> pro: patches tier, status, monthlyUnits to pro config; schedules KV sync; schedules `extendRetention`
- Downgrade pro -> hobby: patches tier, monthlyUnits to hobby config; schedules KV sync; does NOT schedule `extendRetention`
- Already pro, set to pro: still patches, schedules KV sync, no retention extension

**Error cases:**

- Subscription not found for orgId: throws

**What to assert:**

- `ctx.db.patch` called with correct tier and `TIER_CONFIG[tier].monthlyUnits`
- `ctx.scheduler.runAfter` called for KV sync
- `ctx.scheduler.runAfter` called for retention extension only on hobby->pro transition

### `addAddonUnits`

**Happy paths:**

- Adds units to existing addonUnits (e.g., 0 + 50000 = 50000)
- Cumulative: adds to non-zero addonUnits

**Error cases:**

- `units <= 0`: throws
- Subscription not found: throws

### `setStripeCustomerId`

**Happy path:**

- Patches subscription with stripeCustomerId

**Error case:**

- Subscription not found: throws

### `upsertStripeSubscriptionState`

**Happy paths:**

- Updates all Stripe-related fields on subscription
- Resets `currentPeriodOverageSpentCents` to 0 when `currentPeriodStart` changes (period renewal)
- Preserves `currentPeriodOverageSpentCents` when period start is unchanged
- Cancels grace period scheduler when transitioning to `active`
- Clears `gracePeriodSchedulerId` when status is `active`
- Uses existing field values as fallbacks for optional args

**Error cases:**

- Subscription not found: throws

**Edge cases:**

- Partial args (only status provided): all other fields default to existing values
- `cancelAtPeriodEnd: true` then `cancelAtPeriodEnd: undefined`: verify field set

### `creditAddonPurchase`

**Happy paths:**

- Inserts addon purchase record, increments `addonUnits` and `addonPurchaseCount`
- Clears `autoTopupPendingSince`
- Schedules KV sync

**Idempotency:**

- Duplicate `stripePaymentIntentId`: returns early without inserting or patching (critical)

**Error cases:**

- Subscription not found: throws

**What to assert:**

- `ctx.db.insert('addonPurchases', ...)` called with correct fields including `periodStart` from subscription
- `ctx.db.patch` updates `addonUnits`, `addonPurchaseCount`, clears `autoTopupPendingSince`

### `revokeAddonPurchase`

**Happy paths:**

- Finds purchase by `stripePaymentIntentId`, deducts `purchase.units` from subscription's `addonUnits`
- Schedules KV sync

**Edge cases:**

- Purchase not found: returns early (no-op)
- Subscription not found after purchase found: returns early
- Revocation would make `addonUnits` negative: clamps to 0 via `Math.max(0, ...)`

### `revertToHobby`

**Happy paths:**

- Resets tier to hobby with hobby config values
- Zeros out addon units, overage spent, auto overage settings
- Sets new 30-day period
- Clears all Stripe IDs
- Cancels grace period scheduler if set
- Schedules KV sync

**Edge cases:**

- Subscription not found: returns early
- No `gracePeriodSchedulerId` set: skips cancel (no error)

### `scheduleGraceSuspension`

**Happy paths:**

- Status is `grace` and no existing scheduler: schedules `transitionGraceToSuspended` after 14 days, stores scheduler ID

**Guards (no-ops):**

- Subscription not found
- Status is not `grace`
- `gracePeriodSchedulerId` already set (prevents duplicate schedulers)

### `transitionGraceToSuspended`

**Happy path:**

- Status is `grace`: patches to `suspended`, clears `gracePeriodSchedulerId`, schedules KV sync

**Guards:**

- Subscription not found: no-op
- Status is not `grace` (already resolved): no-op

### `reserveAutoTopup`

**Happy path:**

- Pro tier, autoOverage enabled, within cap: increments `currentPeriodOverageSpentCents`, returns `{ ok: true, idempotencyKey }`

**Rejection cases (return `{ ok: false, reason }`):**

- Subscription not found: `subscription_not_found`
- Not pro tier: `not_pro`
- `autoOverage` not enabled: `auto_topup_disabled`
- Would exceed `overageCapCents`: `cap_reached`

**Edge cases:**

- No cap set (`overageCapCents` undefined): no cap check, always allowed
- Cap exactly met (spent + amount === cap): allowed (only `>` is rejected)
- Verify idempotency key format: `auto-topup:{orgId}:{periodStart}:{purchaseCount}`

### `releaseAutoTopupReservation`

**Happy path:**

- Decrements `currentPeriodOverageSpentCents`, clears `autoTopupPendingSince`
- Clamps to 0 via `Math.max(0, ...)`

**Edge case:**

- Subscription not found: no-op

---

## Internal Actions

### `triggerAutoTopup`

This is the most complex function. It orchestrates: reservation -> Stripe charge -> credit.

**Happy path:**

1. Calls `reserveAutoTopup` (mock returns `{ ok: true, idempotencyKey }`)
2. Creates Stripe invoice item
3. Creates Stripe invoice with idempotency key
4. Pays invoice
5. Lists invoice payments to extract `paymentIntentId`
6. Calls `creditAddonPurchase`
7. Returns `{ ok: true, invoiceId }`

**Reservation rejected:**

- `reserveAutoTopup` returns `{ ok: false, reason: 'cap_reached' }`: returns `{ ok: false, reason }` without calling Stripe

**Stripe failure + rollback:**

- `stripe.invoiceItems.create` throws: calls `releaseAutoTopupReservation`, re-throws
- `stripe.invoices.create` throws: calls `releaseAutoTopupReservation`, re-throws
- `stripe.invoices.pay` returns non-`paid` status: throws, triggers rollback
- `stripe.invoices.pay` throws: calls `releaseAutoTopupReservation`, re-throws

**Edge cases:**

- `units <= 0` or `amountCents <= 0`: throws before any work
- Missing stripe customer: throws
- Invoice paid but no `paymentIntentId` extractable: throws (after payment succeeds -- this is a real concern)

**What to assert (carefully):**

- `releaseAutoTopupReservation` is called on any Stripe failure
- `creditAddonPurchase` is NOT called if Stripe fails
- Stripe idempotency key from reservation is passed to `invoices.create`

---

## Public Queries

### `getForCurrentUser`

| Scenario                                     | Expected                            |
| -------------------------------------------- | ----------------------------------- |
| Authenticated user with org and subscription | Returns subscription document       |
| User has no orgId                            | Returns `null`                      |
| No subscription for org                      | Returns `null`                      |
| Unauthenticated                              | Throws (via `requireTraceFlowRole`) |

### `getBillingSummaryForCurrentUser`

| Scenario                                 | Expected                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Full data (subscription, members, usage) | Returns computed summary with correct `totalUsed`, `totalAvailable`, `remaining`, `seatsRemaining` |
| No subscription                          | Returns `null`                                                                                     |
| No usage record for current period       | `totalUsed = 0`, `remaining = totalAvailable`                                                      |
| Usage exceeds available                  | `remaining` clamped to 0                                                                           |
| More members than seats                  | `seatsRemaining` clamped to 0                                                                      |

### `getByOrgId` / `getByStripeSubscriptionId` / `getByStripeCustomerId`

Simple index lookups. Test:

- Returns document when found
- Returns `null` when not found

---

## Public Actions (Stripe interactions)

### `createOrgCheckoutSession`

**Happy path:**

- Creates Stripe customer if none exists (with idempotency key)
- Persists `stripeCustomerId` to both org and subscription tables
- Creates checkout session with pro + seat line items
- Returns `{ url }`

**Error cases:**

- No org: throws
- Not org owner: throws
- Already has active/grace subscription with `stripeSubscriptionId`: throws with portal guidance message
- Missing `STRIPE_SECRET_KEY`: throws

**Edge cases:**

- Existing `stripeCustomerId` on org: skips customer creation
- Existing `stripeCustomerId` on subscription (but not org): uses it
- Seat quantity from existing subscription, minimum 1

### `createAddonCheckoutSession`

**Happy path:**

- Validates pro tier, creates payment-mode checkout session
- Returns `{ url }`

**Error cases:**

- `units <= 0`: throws
- Not authenticated: throws
- No org / not owner: throws
- Not pro tier: throws
- No `stripeCustomerId`: throws

**Edge cases:**

- `quantity` defaults to 1, minimum 1
- Invoice metadata includes `addonUnits` and `mode: 'manual'`

### `createBillingPortalSession`

**Happy path:**

- Creates Stripe billing portal session, returns `{ url }`

**Error cases:**

- Not authenticated: throws
- No org / not owner: throws
- No `stripeCustomerId`: throws

### `updateSeatQuantity`

**Happy path:**

- Updates Stripe subscription seat item quantity
- Calls `upsertStripeSubscriptionState` with updated state

**Error cases:**

- `seatQuantity < 1`: throws
- Not owner: throws
- No `stripeSubscriptionId` or `stripeSeatItemId`: throws
- `seatQuantity < activeMembers`: throws with member count in message

### `reconcileCurrentOrgWithStripe`

**Happy path:**

- Retrieves Stripe subscription, updates local state to match
- Returns `{ reconciled: true }`

**Error cases:**

- Not owner: throws
- No `stripeSubscriptionId`: returns `{ reconciled: false, reason: 'missing_stripe_subscription' }`

---

## Public Mutations

### `updateAutoOverageSettings`

**Happy path:**

- Sets `autoOverage` and `overageCapCents` on subscription
- Schedules KV sync

**Error cases:**

- Unauthenticated: throws
- Not org owner: throws
- No subscription: throws
- Not pro tier: throws

---

## Webhook Handler (`http.ts /stripe/webhook`)

The webhook handler in `http.ts` uses `findSubscriptionItems` and `mapStripeStatusToInternal` from subscriptions.ts. Test these webhook event types:

### `checkout.session.completed`

- Extracts `orgId` from metadata, retrieves subscription, calls `upsertStripeSubscriptionState`
- Missing `orgId` in metadata: breaks (no-op)
- Missing subscription ID or customer: breaks

### `customer.subscription.created` / `customer.subscription.updated`

- Resolves org via `resolveOrgSubscription` (tries subscription ID first, then customer ID, then org table)
- Updates state including `cancelAtPeriodEnd`
- No matching subscription found: breaks

### `customer.subscription.deleted`

- Calls `revertToHobby` for the org

### `invoice.paid`

- **Addon invoice** (has `addonUnits` in metadata): extracts payment intent from `invoicePayments.list`, calls `creditAddonPurchase`
- **Subscription renewal invoice**: resolves subscription, calls `upsertStripeSubscriptionState` with status `active`
- No `paymentIntentId` extractable: breaks
- Invalid `addonUnits` (not finite, <= 0): breaks

### `invoice.payment_failed`

- Sets status to `grace`, schedules grace suspension

### `charge.refunded`

- Calls `revokeAddonPurchase` with `paymentIntentId`

### Cross-cutting webhook concerns

- **Signature validation**: invalid signature returns 400
- **Missing signature header**: returns 400
- **Missing `STRIPE_WEBHOOK_SECRET`**: returns 500
- **Idempotency**: duplicate `event.id` returns `{ ok: true, deduped: true }`
- **Processing failure**: catches error, calls `markFailed`, returns 500 for Stripe retry
- **Stale event reprocessing**: events stuck in `processing` for >5 min are retried

---

## Auto-Topup Flow (`usage.ts checkAutoTopup`)

### `checkAutoTopup`

**Happy path:**

- Pro tier, autoOverage enabled, usage >= 90%, within cap: sets `autoTopupPendingSince`, schedules `triggerAutoTopup`

**Guards (no-ops):**

- Subscription not found
- Not pro tier
- `autoOverage` not enabled
- Recent pending topup within 15-minute dedup window
- Usage ratio < 90%
- `totalAvailable <= 0`
- Would exceed cap

**Edge cases:**

- Usage exactly at 90% threshold: triggers
- Usage at 89.9%: does not trigger
- Dedup window: topup at T=0, usage report at T=14min should NOT trigger; at T=16min should trigger
- Cap check: `currentPeriodOverageSpentCents + addonAmountCents > cap` prevents scheduling

---

## Race Condition Scenarios

These are the highest-risk scenarios for billing correctness:

### Concurrent auto-topups

Two usage reports arrive simultaneously, both at 90%+ usage. `reserveAutoTopup` uses Convex serialized mutations to prevent double-reservation.

**Test:** Two sequential calls to `reserveAutoTopup` with cap=800. First reserves 800, second should get `cap_reached`.

### Concurrent checkout + webhook

User starts checkout, webhook arrives before checkout action finishes writing customer ID. `resolveOrgSubscription` has a 3-step fallback (subscription ID -> customer ID on subscriptions table -> customer ID on orgs table).

**Test:** Verify `resolveOrgSubscription` returns correct subscription via each of the 3 lookup paths.

### Period renewal resets overage

When `upsertStripeSubscriptionState` receives a new `currentPeriodStart`, it resets `currentPeriodOverageSpentCents` to 0.

**Test:** Call `upsertStripeSubscriptionState` with new period start, verify overage reset.

### Grace period resolution

Payment fails -> grace scheduled -> payment succeeds before 14 days.

**Test:**

1. `upsertStripeSubscriptionState` with status `grace`
2. `scheduleGraceSuspension` stores scheduler ID
3. `upsertStripeSubscriptionState` with status `active` cancels the scheduler

### Refund after addon credit

Charge refunded after addon units already credited and partially consumed.

**Test:** `revokeAddonPurchase` clamps `addonUnits` to 0 when revocation exceeds remaining units.

---

## Test File Organization

```
packages/convex/__tests__/subscriptions/
  pure-functions.test.ts        # findSubscriptionItems, mapStripeStatusToInternal
  internal-mutations.test.ts    # setTier, addAddonUnits, upsertStripeSubscriptionState,
                                # creditAddonPurchase, revokeAddonPurchase, revertToHobby,
                                # scheduleGraceSuspension, transitionGraceToSuspended,
                                # reserveAutoTopup, releaseAutoTopupReservation
  queries.test.ts               # getForCurrentUser, getBillingSummaryForCurrentUser,
                                # getByOrgId, getByStripeSubscriptionId, getByStripeCustomerId
  actions.test.ts               # createOrgCheckoutSession, createAddonCheckoutSession,
                                # createBillingPortalSession, updateSeatQuantity,
                                # reconcileCurrentOrgWithStripe, triggerAutoTopup
  mutations.test.ts             # updateAutoOverageSettings
  auto-topup.test.ts            # checkAutoTopup (from usage.ts)
  race-conditions.test.ts       # Concurrent scenarios from the race conditions section
```

The webhook handler tests belong in the existing `packages/convex/__tests__/http.test.ts` file (or a new `http-stripe-webhook.test.ts` alongside it), following the same `createApp(deps)` / `createMockCtx()` pattern already established there.

## Priority Order

1. **Pure functions** -- zero dependencies, fast to write, high confidence baseline
2. **Internal mutations** -- core billing state machine, highest business risk
3. **Race conditions** -- billing correctness under concurrency
4. **Webhook handler** -- integration point with Stripe
5. **Actions** -- require most mocking (Stripe SDK), test orchestration logic
6. **Queries** -- low risk, straightforward
