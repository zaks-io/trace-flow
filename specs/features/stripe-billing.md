# Stripe Billing & Subscription System

## Overview

Integrate Stripe for payment processing using the [Convex Stripe component](https://www.convex.dev/components/stripe). Per-user monthly billing with hard usage limits, manual addon purchases (Pro only), and optional automatic overage.

## Decisions

- **Stripe Checkout + Fixed Tiers** (Option A) over Stripe Meters/usage-based billing. We already track usage precisely via Durable Objects and Convex, so Stripe just handles payment collection.
- **Convex Stripe component** for checkout sessions, webhook handling, customer management, and portal.
- **Hard limits** everywhere. When units exhausted, proxy returns 429 with clear JSON error. Never silently degrade.
- **Per-user subscriptions**, not per-seat org pricing. Each user has their own subscription. Orgs pool member units.
- **Hobby users cannot purchase addons.** Must upgrade to Pro first.
- **Monthly billing only** for v1. Annual billing planned for future once pricing stabilizes.
- **No free trials** in v1. Planned for future.
- **14-day grace period** on failed payments before suspension.
- **Stripe Tax** enabled from day one for automatic tax calculation.
- **Billing period alignment**: Usage periods align to Stripe's `current_period_start` / `current_period_end`, not calendar months.

## Billing Model

### Per-User Subscriptions

- Each user has their own Stripe customer + subscription
- Solo user = 1 user, 1 org (auto-created on signup)
- Orgs allow sharing API keys and trace data across team members
- Org's total available units = sum of all member subscription units + addon units
- Stripe customer is the individual user, not the org

### Tiers

|                | Hobby (Free) | Pro (Paid)                   |
| -------------- | ------------ | ---------------------------- |
| Price          | $0           | $TBD/user/month              |
| Included units | TBD          | TBD                          |
| Overage        | Hard blocked | Manual addon OR auto-overage |
| Addons         | Not allowed  | Yes                          |

### Addon Units & Overage (Pro Only)

Hobby users who hit their limit are hard-blocked. They must upgrade to Pro to get more capacity.

Pro users have two options when approaching their included unit limit:

1. **Manual addon packs**: Buy N units on demand via a one-time Stripe Checkout charge.
2. **Auto-overage**: Automatically pre-purchase addon packs when usage crosses a threshold (e.g., 80% of remaining units).

**Cost controls**: Users set a monthly spend cap (e.g., "never charge me more than $50/mo in overages"). Auto-overage stops purchasing once the cap is reached. When the cap is hit, the account is hard-blocked like any other limit.

### Auto-Overage: Async Pre-Purchase

Auto-overage cannot be synchronous (Stripe charges take seconds, proxy requests must be fast). Instead:

```
DO tracks usage, detects threshold crossed (e.g., 80% consumed)
  → DO fires webhook/HTTP call to Convex action
  → Convex action charges stored payment method via Stripe API
  → On success: credits addon units to subscription
  → KV sync updates proxy limits
  → Subsequent requests see new capacity immediately

If charge fails or spend cap reached:
  → No addon credited
  → Once units fully exhausted, proxy returns 429
```

The threshold should be configurable but default to triggering when ~20% of remaining units are left, giving time for the async purchase to complete before the user actually hits zero.

## Architecture

### Data Flow: Upgrade to Pro

```
User clicks "Upgrade to Pro"
  → Convex action creates Stripe Checkout Session (via convex-stripe component)
  → User redirected to Stripe-hosted checkout
  → User pays
  → Stripe fires webhook (checkout.session.completed)
  → Convex HTTP action receives webhook (convex-stripe component)
  → Convex mutation updates user's subscription tier + stripeSubscriptionId
  → Recalculates org unit pool
  → Triggers KV sync to Cloudflare (existing pattern)
  → Proxy worker immediately sees new limits
```

### Data Flow: Manual Addon Purchase (Pro Only)

```
User clicks "Buy 100k units"
  → Frontend checks user is Pro (hobby users see "Upgrade" instead)
  → Convex action creates Stripe Checkout Session (one-time payment)
  → User completes payment
  → Webhook: payment_intent.succeeded
  → Convex mutation credits addon units to org's pool
  → KV sync updates proxy limits
```

### Data Flow: Auto-Overage (Pro Only, Async)

```
Proxy request arrives → DO increments usage counter
  → DO detects usage crossed auto-overage threshold
  → DO sends HTTP POST to Convex endpoint (fire-and-forget via waitUntil)
  → Convex action:
    1. Verify auto-overage enabled for this user
    2. Check monthly spend cap not exceeded
    3. Charge stored payment method (Stripe PaymentIntent)
    4. On success: credit addon units, record purchase, sync KV
    5. On failure: log error, user will hit hard block when units exhaust
  → Meanwhile, current request proceeds normally (units not yet exhausted)
  → Future requests benefit from newly credited units
```

### System Diagram

```
┌─────────────────────────────────────────────────────┐
│                     Frontend                         │
│  Upgrade button → Stripe Checkout Session            │
│  Manage Billing → Stripe Customer Portal             │
│  Buy Addons → Stripe Checkout (Pro only)             │
│  Settings → auto-overage toggle + spend cap          │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│                 Convex Backend                        │
│                                                      │
│  Convex Stripe Component                             │
│  ├── Customers (linked to users)                     │
│  ├── Subscriptions (per-user recurring)              │
│  ├── Checkout Sessions                               │
│  ├── Payments / Invoices                             │
│  └── Webhook Handler                                 │
│                                                      │
│  Custom Logic                                        │
│  ├── subscriptions.ts (tier mgmt, user↔org pool)     │
│  ├── overage.ts (addon purchase, auto-overage)       │
│  ├── usage.ts (existing - hard limit enforcement)    │
│  └── cloudflare.ts (KV sync - existing)              │
└───────────────────────┬─────────────────────────────┘
                        │ KV sync
┌───────────────────────▼─────────────────────────────┐
│              Cloudflare Proxy Worker                  │
│                                                      │
│  Auth → Status Check → Usage Check → HARD BLOCK      │
│  Returns 429 JSON with clear error + metadata        │
│  Blocks suspended/canceled accounts entirely         │
│  Reads subscription + limits + status from KV        │
└─────────────────────────────────────────────────────┘
```

## Hard Limit Enforcement

### Current Behavior (Soft Limits)

```
Request arrives → Auth → Usage check
  → If exceeded: proxy request anyway, skip trace capture, set header
  → Client gets normal 2xx response from LLM provider
  → X-Trace-Flow-Usage-Exceeded: true header added
```

### New Behavior (Hard Limits)

```
Request arrives → Auth → Account status check → Usage check
  → If account suspended/canceled: return 429 immediately
  → If units exhausted: return 429 immediately
  → Otherwise: proxy normally
```

### 429 Response Format

All 429 responses use a consistent JSON structure. The `code` field is machine-readable for programmatic handling. The `message` is human-readable.

**Usage limit exceeded:**

```json
{
  "error": "Usage limit exceeded",
  "code": "USAGE_LIMIT_EXCEEDED",
  "message": "Your organization has used all available units for this billing period. Upgrade to Pro or purchase addon units at https://app.traceflow.dev/settings/billing",
  "details": {
    "resetAt": "2025-02-01T00:00:00Z",
    "tier": "hobby"
  }
}
```

Headers: `Retry-After: <seconds until period reset>`, `X-Trace-Flow-Error: USAGE_LIMIT_EXCEEDED`

**Account suspended:**

```json
{
  "error": "Account suspended",
  "code": "ACCOUNT_SUSPENDED",
  "message": "Your account has been suspended due to a billing issue. Update your payment method at https://app.traceflow.dev/settings/billing"
}
```

**Account canceled:**

```json
{
  "error": "Account canceled",
  "code": "ACCOUNT_CANCELED",
  "message": "This account has been canceled. Contact support to reactivate."
}
```

## Account States

| State       | Meaning                                 | Proxy Behavior                     |
| ----------- | --------------------------------------- | ---------------------------------- |
| `active`    | Subscription paid and current           | Normal operation                   |
| `past_due`  | Payment failed, in 14-day grace period  | Normal operation (Stripe retrying) |
| `suspended` | 14 days past_due, payment not recovered | 429 on ALL requests                |
| `canceled`  | User canceled or purged after 90 days   | 429 on ALL requests                |

## Failed Payment & Dunning Timeline

Based on [industry best practices](https://docs.stripe.com/billing/revenue-recovery/smart-retries): customers who retain access during grace are 40% more likely to recover. Stripe Smart Retries ("8 retries over 2 weeks") recovers ~8% additional revenue.

| Day    | Action                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| **0**  | Payment fails. Stripe Smart Retries begins. Email #1: "Payment failed, please update your card."                       |
| **3**  | Email #2: "Still having trouble. Update your payment method."                                                          |
| **7**  | Email #3: "Your account will be suspended in 7 days if payment isn't resolved."                                        |
| **14** | **Suspend account.** Proxy returns 429 on all requests. Dashboard shows "update payment" banner. Status → `suspended`. |
| **30** | Email: "Your data will be deleted in 60 days unless you reactivate."                                                   |
| **90** | Data purge. Account closed. Status → `canceled`.                                                                       |

Stripe settings: configure Smart Retries with "8 retries within 2 weeks", then mark subscription as `past_due` on failure (not auto-cancel).

## Billing Period Alignment

Usage periods must align with Stripe's billing cycle, not calendar months.

- Store `currentPeriodStart` and `currentPeriodEnd` from Stripe's subscription object
- When `invoice.paid` fires with `billing_reason: 'subscription_cycle'`, update period boundaries and reset usage counters
- The Durable Object receives period boundaries via KV sync and uses those for rollover detection (replacing the current `computePeriod()` calendar-month logic)
- Stripe's `billing_cycle_anchor` is set at subscription creation time (defaults to signup date)

## Schema Changes

### Modify `users`

```typescript
users: defineTable({
  // ...existing fields
  stripeCustomerId: v.optional(v.string()),
});
```

### Modify `subscriptions`

Subscriptions are per-user. The org's effective limits are computed by summing all member subscriptions.

```typescript
subscriptions: defineTable({
  userId: v.id('users'),
  orgId: v.id('organizations'),
  tier: v.union(v.literal('hobby'), v.literal('pro')),
  status: v.union(
    v.literal('active'),
    v.literal('past_due'),
    v.literal('suspended'),
    v.literal('canceled'),
  ),
  stripeSubscriptionId: v.optional(v.string()),
  monthlyUnits: v.number(),
  addonUnits: v.number(),
  // Overage controls (Pro only)
  autoOverage: v.boolean(),
  overageCapCents: v.optional(v.number()), // monthly spend cap in cents; undefined = no cap
  currentPeriodOverageSpentCents: v.number(), // resets each billing period
  // Billing period boundaries (from Stripe)
  currentPeriodStart: v.number(), // epoch ms
  currentPeriodEnd: v.number(), // epoch ms
})
  .index('by_user', ['userId'])
  .index('by_org', ['orgId']);
```

### New table: `addonPurchases`

```typescript
addonPurchases: defineTable({
  userId: v.id('users'),
  orgId: v.id('organizations'),
  units: v.number(),
  amountCents: v.number(),
  stripePaymentIntentId: v.string(),
  auto: v.boolean(), // true if triggered by auto-overage, false if manual
}).index('by_org', ['orgId']);
```

## Webhook Events

All webhook handlers must be **idempotent**. Use `stripePaymentIntentId` / `stripeSubscriptionId` as deduplication keys. Check if the event has already been processed before making mutations.

| Event                           | Action                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `checkout.session.completed`    | Activate pro subscription, set tier, recalculate org pool, sync KV          |
| `invoice.paid`                  | Confirm renewal, update period boundaries, reset usage counters + overage   |
| `invoice.payment_failed`        | Start dunning clock, send email, set status `past_due`                      |
| `customer.subscription.updated` | Handle plan changes, recalculate org pool, sync KV                          |
| `customer.subscription.deleted` | Set status `canceled`, recalculate org pool, sync KV                        |
| `payment_intent.succeeded`      | Credit addon units (check `stripePaymentIntentId` for idempotency), sync KV |

### Usage Reset on Renewal

When `invoice.paid` fires for a subscription renewal (`billing_reason: 'subscription_cycle'`):

1. Update `currentPeriodStart` and `currentPeriodEnd` from invoice
2. Reset `currentPeriodOverageSpentCents` to 0
3. Reset the Durable Object's subscription usage counter (via KV sync with new period boundaries)
4. Addon units carry over (they don't expire)

## Changes to Existing Code

### Proxy: Hard Limits

**`workers/proxy/src/index.ts`**: Replace soft limit pass-through with hard 429 block.

```
Current (lines ~202-212):
  if (usageCheck.status === 'exceeded') → pass through, add header, skip capture

New:
  if (usageCheck.status === 'exceeded') → return c.json(errorBody, 429) immediately
```

### Proxy: Account Status Check

**`workers/proxy/src/auth.ts`**: After validating API key, read subscription status from KV (`sub:{orgId}`). Block `suspended` and `canceled` accounts entirely (429 before even attempting to proxy).

### Proxy: Usage Check

**`workers/proxy/src/index.ts`**: The existing usage check (`checkUsage`) already returns `{ status: 'exceeded' }`. Just change the handler to return 429 instead of passing through.

### KV Sync

**`packages/convex/cloudflare.ts`**: Add `status` and period boundaries to `SubscriptionKVData`. When syncing, compute org-level totals by summing all member subscriptions.

```typescript
interface SubscriptionKVData {
  tier: 'hobby' | 'pro'; // highest tier in org
  status: 'active' | 'past_due' | 'suspended' | 'canceled'; // worst status in org
  monthlyUnits: number; // sum of all member subscription units
  addonUnits: number; // sum of all member addon units
  currentPeriodStart: number;
  currentPeriodEnd: number;
}
```

### Durable Object: Period Alignment

**`workers/proxy/src/usage-tracker.ts`**: Replace `computePeriod()` calendar-month logic with period boundaries from KV data. The DO receives `currentPeriodStart` and `currentPeriodEnd` via the subscription config and uses those for rollover detection.

## Stripe Tax

Enable Stripe Tax from day one to calculate and collect tax automatically. Filing and remittance will be handled later as the business scales -- for now we just need to capture everything correctly so we're not retroactively fixing tax issues.

### Setup

1. **Enable Stripe Tax** in Stripe Dashboard settings
2. **Set head office address** (determines tax origin for situs rules)
3. **Assign product tax code** for SaaS services to both products
4. **Set tax behavior**: tax-exclusive (price + tax) for USD — standard for B2B SaaS
5. **Enable `automatic_tax`** on all Checkout Sessions and subscriptions

### What This Gets Us

- Stripe calculates correct tax automatically based on customer location + product type
- Customer address collected during Stripe Checkout (required for tax calculation)
- Tax is collected on every transaction from day one (no retroactive headaches)
- B2B customers with valid tax IDs (EU VAT, UK VAT, AU ABN) get reverse charge (zero tax)
- Tax-exclusive pricing: $TBD/month + applicable tax (standard for B2B SaaS)
- Stripe monitors sales volume per jurisdiction and alerts when approaching nexus thresholds
- Tax reporting available in Stripe Dashboard when we're ready to file

### Implementation

- Pass `automatic_tax: { enabled: true }` when creating Checkout Sessions
- Pass `automatic_tax: { enabled: true }` when creating subscriptions
- Collect customer tax IDs via Stripe Checkout (enable in Checkout Session config)
- No custom tax logic needed — Stripe handles calculation, collection, and reporting

### Costs

- Stripe Tax Basic: 0.5% of transaction amount (drops to 0.4% at $100k/mo volume)
- Covers US sales tax (all states), EU VAT, UK VAT, AU/NZ/SG GST, CA GST/HST/PST

### Not Yet (Future)

- Tax registration with individual jurisdictions (add as needed when nexus thresholds are hit)
- Filing and remittance (add TaxJar, Anrok, or Stripe Tax Complete when volume warrants it)

## Stripe Product Setup

Products to create in Stripe Dashboard:

1. **Trace Flow Pro** - Recurring monthly price ($TBD/user/month), tax code for SaaS
2. **Addon Unit Pack** - One-time price per unit pack (e.g., 100k units for $TBD), tax code for SaaS

Both products: `automatic_tax` enabled, tax-exclusive pricing.

## Frontend Changes

### New/Modified Pages

- **`/app/usage`** (existing) - Add upgrade CTA, addon purchase button (Pro only), overage settings
- **`/app/settings/billing`** (new) - Auto-overage toggle, spend cap configuration, "Manage Billing" button (Stripe Portal)
- **Upgrade flow** - Button on usage page or settings that redirects to Stripe Checkout

### Stripe Customer Portal

Used for:

- Updating payment method
- Viewing invoice history
- Canceling subscription

Accessed via "Manage Billing" button that creates a Stripe Portal Session and redirects.

## Not in v1

- Annual billing (planned, not yet -- pricing needs to stabilize)
- Free trials (planned for future)
- Additional tiers beyond hobby/pro
- Stripe Meters / native usage-based billing (may revisit if billing model evolves)
- Coupon/promo codes
- Downgrade flow (Pro → Hobby) -- TBD, needs more thought on data retention, unit handling, org member impact
- Tax filing and remittance (Stripe Tax captures everything; add filing via TaxJar/Anrok later)
- Tax registration (Stripe monitors thresholds; register as needed)

## Open Questions

- [ ] Final pricing per user
- [ ] Final included unit counts per tier
- [ ] Addon pack size and pricing
- [ ] Auto-overage threshold percentage (proposed: trigger at 80% consumed)
- [ ] Org unit pooling: when an org has mixed tiers (hobby + pro members), how do units aggregate?
- [ ] Email templates for dunning (reuse Resend + React Email from invite system)
- [ ] Convex Stripe component table relationship -- what lives in component tables vs custom tables?

## References

- [Stripe Subscription Overview](https://docs.stripe.com/billing/subscriptions/overview)
- [Build a Subscriptions Integration](https://docs.stripe.com/billing/subscriptions/build-subscriptions)
- [Stripe Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
- [Convex Stripe Component](https://www.convex.dev/components/stripe)
- [Convex Stripe Starter Template](https://www.convex.dev/templates/stripe)
- [Stripe Tax Documentation](https://docs.stripe.com/tax)
- [Set up Stripe Tax](https://docs.stripe.com/tax/set-up)
- [Stripe Tax Pricing](https://stripe.com/tax/pricing)
- [Stripe Billing Cycle Anchor](https://docs.stripe.com/billing/subscriptions/billing-cycle)
- [Stripe Webhooks for Subscriptions](https://docs.stripe.com/billing/subscriptions/webhooks)
