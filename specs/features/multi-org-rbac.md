# Multi-Org & RBAC

## Overview

Replace the boolean `isAdmin` flag with a role-based access control system scoped to organizations. Every permission check becomes org-aware: "can this user do X within org Y?"

## Current State

### How authorization works today

1. **Platform admin**: `users.isAdmin` boolean. Used by `requireAdmin()` in `users.ts`. Guards: invite management (`invites.ts`), waitlist (`waitlist.ts`), admin dashboard (`admin.ts`), KV sync (`cloudflare.ts`).
2. **Org ownership**: `organizations.ownerId === user._id` check. Inline in every billing function (`subscriptions.ts` has 6 occurrences), plus `organizations.rename()` and `invites.createOrgInvite()`.
3. **Org membership**: `organizationMembers` table with `role: 'owner' | 'member'` and `status: 'active' | 'invited' | 'removed'`. The `role` field exists but is never checked -- all members have equal read access.
4. **Auth0 role**: `requireTraceFlowRole()` checks `neuron/roles` in the Auth0 identity token. This gates platform access, not org-level permissions.
5. **Frontend**: `AdminContext.tsx` provides `useIsAdmin()` from `app.ts sessionContext` which reads `user.isAdmin`.

### Problems

- `isAdmin` is platform-global, not org-scoped. An admin of one org is admin everywhere.
- Ownership checks are copy-pasted inline (6+ locations in `subscriptions.ts` alone).
- No `admin` role -- the org owner must do everything. No delegation possible.
- No `viewer` role -- all members can modify API keys, alerts, etc.
- `canAddMember` in `organizations.ts` checks seat count but not permissions.

## Target Design

### Role Hierarchy

```
owner > admin > member > viewer
```

| Role     | Description                                                                           |
| -------- | ------------------------------------------------------------------------------------- |
| `owner`  | Full control. Manages billing, deletes org, transfers ownership. One per org.         |
| `admin`  | Manages members, API keys, alerts, org settings. Cannot manage billing or delete org. |
| `member` | Creates and manages own API keys. Views traces, dashboards, usage.                    |
| `viewer` | Read-only access to traces and dashboards. Cannot create API keys.                    |

### Permission Matrix

| Action                                   | owner | admin | member | viewer |
| ---------------------------------------- | ----- | ----- | ------ | ------ |
| View traces & dashboards                 | Y     | Y     | Y      | Y      |
| View usage & billing summary             | Y     | Y     | Y      | Y      |
| Create/revoke own API keys               | Y     | Y     | Y      | -      |
| View all org API keys                    | Y     | Y     | Y      | -      |
| Delete other users' API keys             | Y     | Y     | -      | -      |
| Create/manage alerts                     | Y     | Y     | Y      | -      |
| Invite members                           | Y     | Y     | -      | -      |
| Remove members                           | Y     | Y     | -      | -      |
| Change member roles                      | Y     | Y\*   | -      | -      |
| Rename organization                      | Y     | Y     | -      | -      |
| Manage billing (checkout, seats, addons) | Y     | -     | -      | -      |
| Configure auto-overage                   | Y     | -     | -      | -      |
| Reconcile with Stripe                    | Y     | -     | -      | -      |
| Access billing portal                    | Y     | -     | -      | -      |
| Transfer ownership                       | Y     | -     | -      | -      |
| Delete organization                      | Y     | -     | -      | -      |

\* Admins cannot promote to owner or demote other admins.

### Platform Admin

`isAdmin` on `users` stays as a separate concept for platform-wide operations (waitlist management, platform stats, global KV sync). It is orthogonal to org roles. A platform admin is NOT automatically an org admin -- they are separate authorization domains.

## Schema Changes

### `organizationMembers` table

Current:

```ts
role: v.union(v.literal('owner'), v.literal('member'));
```

New:

```ts
role: v.union(v.literal('owner'), v.literal('admin'), v.literal('member'), v.literal('viewer'));
```

No new indexes needed. The existing `by_org_id`, `by_user_id`, and `by_org_id_status` indexes are sufficient. Role lookups always go through membership queries that already filter by orgId + userId.

### `@trace-flow/types`

Add to `packages/types/src/index.ts`:

```ts
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export const ORG_ROLE_HIERARCHY: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
} as const;
```

### No changes needed

- `users.isAdmin` stays (platform admin, orthogonal to org RBAC)
- `organizations.ownerId` stays (fast lookup for ownership transfer, billing)
- `subscriptions` table -- unchanged
- `SubscriptionKVData` -- unchanged (proxy does not need role data; it checks API keys and org billing status, not user roles)

## Auth Helper: `requireOrgRole()`

Add to `packages/convex/auth.ts`:

```ts
import type { OrgRole } from '@trace-flow/types';
import { ORG_ROLE_HIERARCHY } from '@trace-flow/types';

export async function requireOrgRole(
  ctx: AuthContext,
  orgId: Id<'organizations'>,
  minimumRole: OrgRole,
): Promise<{ user: Doc<'users'>; membership: Doc<'organizationMembers'> }> {
  const user = await requireEnabledUser(ctx);

  const membership = await ctx.db
    .query('organizationMembers')
    .withIndex('by_user_id', (q) => q.eq('userId', user._id))
    .filter((q) => q.and(q.eq(q.field('orgId'), orgId), q.eq(q.field('status'), 'active')))
    .first();

  if (!membership) {
    throw new Error('You are not a member of this organization');
  }

  const userLevel = ORG_ROLE_HIERARCHY[membership.role as OrgRole];
  const requiredLevel = ORG_ROLE_HIERARCHY[minimumRole];

  if (userLevel < requiredLevel) {
    throw new Error(`This action requires ${minimumRole} role or higher`);
  }

  return { user, membership };
}
```

### Convenience wrappers

```ts
// For the common pattern: current user's org, require a minimum role
export async function requireCurrentOrgRole(
  ctx: AuthContext,
  minimumRole: OrgRole,
): Promise<{ user: Doc<'users'>; membership: Doc<'organizationMembers'> }> {
  const user = await requireEnabledUser(ctx);
  if (!user.orgId) throw new Error('Organization not found');
  return requireOrgRole(ctx, user.orgId, minimumRole);
}
```

## Migration Plan

### Phase 1: Add roles, keep backward compat

1. Add `admin` and `viewer` to the `organizationMembers.role` union in schema.
2. Add `OrgRole` and `ORG_ROLE_HIERARCHY` to `@trace-flow/types`.
3. Add `requireOrgRole()` and `requireCurrentOrgRole()` to `auth.ts`.
4. **No existing behavior changes yet.** All existing members keep their `owner` or `member` role.

### Phase 2: Replace inline ownership checks

Replace the 6+ inline `org.ownerId !== user._id` checks in `subscriptions.ts` with `requireCurrentOrgRole(ctx, 'owner')`. Replace `requireOrgOwner()` private helper in `subscriptions.ts` with the shared helper.

**Files to update:**

| File                                               | Current pattern                   | New pattern                                          |
| -------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| `subscriptions.ts` `requireOrgOwner()`             | Inline `org.ownerId !== user._id` | `requireCurrentOrgRole(ctx, 'owner')`                |
| `subscriptions.ts` `createOrgCheckoutSession`      | Inline ownership check            | `requireCurrentOrgRole(ctx, 'owner')` via `runQuery` |
| `subscriptions.ts` `createAddonCheckoutSession`    | Inline ownership check            | Same                                                 |
| `subscriptions.ts` `createBillingPortalSession`    | Inline ownership check            | Same                                                 |
| `subscriptions.ts` `updateSeatQuantity`            | Inline ownership check            | Same                                                 |
| `subscriptions.ts` `reconcileCurrentOrgWithStripe` | Inline ownership check            | Same                                                 |
| `organizations.ts` `rename`                        | Inline ownership check            | `requireCurrentOrgRole(ctx, 'admin')`                |
| `invites.ts` `createOrgInvite`                     | Inline ownership check            | `requireCurrentOrgRole(ctx, 'admin')`                |

### Phase 3: Gate existing actions by role

| Function                                        | Current guard                              | New guard                              |
| ----------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `organizations.getMembers`                      | `requireTraceFlowRole`                     | `requireCurrentOrgRole(ctx, 'viewer')` |
| `organizations.get`                             | `requireTraceFlowRole`                     | `requireCurrentOrgRole(ctx, 'viewer')` |
| `subscriptions.getForCurrentUser`               | `requireTraceFlowRole`                     | `requireCurrentOrgRole(ctx, 'viewer')` |
| `subscriptions.getBillingSummaryForCurrentUser` | `requireTraceFlowRole`                     | `requireCurrentOrgRole(ctx, 'viewer')` |
| `subscriptions.updateAutoOverageSettings`       | `requireTraceFlowRole` + `requireOrgOwner` | `requireCurrentOrgRole(ctx, 'owner')`  |

API keys (future -- requires `apiKeys.ts` review):

- Create own key: `member`
- List org keys: `member`
- Delete own key: `member`
- Delete others' keys: `admin`

Alerts (future -- requires `alerts.ts` review):

- Create/edit/delete own alerts: `member`
- View all org alerts: `viewer`

### Phase 4: Update frontend

1. Replace `AdminContext` / `useIsAdmin()` with `OrgRoleContext` / `useOrgRole()`.
2. `app.ts sessionContext` should return the user's org role (from `organizationMembers`) instead of (or in addition to) `isAdmin`.
3. Sidebar nav items conditionally shown based on role (billing settings only for owner, invite management for admin+).
4. Platform admin pages (`/admin/*`) continue using `isAdmin` unchanged.

### Phase 5: Deprecate `isAdmin` for org operations

After roles are fully deployed:

1. Remove `requireAdmin()` calls from `invites.ts` `createInvite`, `listInvites`, `revokeInvite` -- replace with `requireCurrentOrgRole(ctx, 'admin')`.
2. Keep `requireAdmin()` only for true platform admin operations (`admin.ts`, `waitlist.ts`, `cloudflare.syncAll`).
3. Clean up `isAdmin` references in frontend to only gate the platform admin page.

## Seat Enforcement in Invites

Currently `invites.ts acceptInvite()` already checks seat limits:

```ts
if (activeMembers.length >= seatLimit) {
  throw new Error('Organization has reached its seat limit...');
}
```

This needs two additions:

1. **Check at invite creation time** (not just acceptance): `createOrgInvite` should call `canAddMember` or an equivalent check. Currently it does not -- you can create unlimited pending invites even when at the seat limit.

2. **Count pending invites toward soft limit**: To prevent inviting 100 people when you have 2 seats remaining, `canAddMember` should include pending org invites in its count:

```ts
export const canAddMember = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return false;

    const activeMembers = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', args.orgId).eq('status', 'active'))
      .collect();

    const pendingInvites = await ctx.db
      .query('invites')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', args.orgId).eq('status', 'pending'))
      .collect();

    const effectiveCount = activeMembers.length + pendingInvites.length;
    return subscription.seatQuantity > effectiveCount;
  },
});
```

The hard gate at `acceptInvite` remains as a safety net.

## Role Assignment Flow

### On org creation (`ensureOrg` in `users.ts`)

Creator gets `owner` role. Already happens today.

### On invite acceptance

Invited users get `member` role by default. Already happens today via `ensureOrgMembership(ctx, orgId, userId, 'member')`.

### Future: invite with role

Extend `createOrgInvite` args to accept an optional `role` parameter (default: `member`). Store it on the invite document and use it during `acceptInvite` -> `ensureOrgMembership`. Constraint: only `admin` and `owner` can invite, and they cannot invite someone at a higher role than their own.

### Role changes

New mutation `updateMemberRole` in `organizations.ts`:

```ts
export const updateMemberRole = mutation({
  args: {
    memberId: v.id('organizationMembers'),
    role: v.union(v.literal('admin'), v.literal('member'), v.literal('viewer')),
  },
  handler: async (ctx, args) => {
    // Cannot set to 'owner' -- ownership transfer is a separate flow
    const member = await ctx.db.get(args.memberId);
    if (!member) throw new Error('Member not found');

    const { membership } = await requireOrgRole(ctx, member.orgId, 'admin');

    // Admins cannot change other admins' roles
    if (membership.role === 'admin' && member.role === 'admin') {
      throw new Error("Admins cannot change other admins' roles");
    }

    // Cannot change owner's role
    if (member.role === 'owner') {
      throw new Error("Cannot change the owner's role. Use ownership transfer.");
    }

    await ctx.db.patch(args.memberId, { role: args.role });
  },
});
```

## Multi-Org User Switching

### Current state

Users have a single `orgId` on their user document. Switching orgs is not supported. The `users.orgId` field acts as the "active org" pointer.

### Design

A user can be a member of multiple organizations (already supported by the `organizationMembers` table -- it has no unique constraint on `userId`). The `users.orgId` field becomes the "active org" that determines which data the user sees.

**New mutation** in `organizations.ts`:

```ts
export const switchOrg = mutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);

    // Verify active membership in target org
    const membership = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .filter((q) => q.and(q.eq(q.field('orgId'), args.orgId), q.eq(q.field('status'), 'active')))
      .first();

    if (!membership) {
      throw new Error('You are not a member of this organization');
    }

    await ctx.db.patch(user._id, { orgId: args.orgId });
  },
});
```

**New query** for the org switcher UI:

```ts
export const listMyOrgs = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const memberships = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    const orgs = await Promise.all(
      memberships.map(async (m) => {
        const org = await ctx.db.get(m.orgId);
        return org ? { ...org, role: m.role } : null;
      }),
    );

    return orgs.filter(Boolean);
  },
});
```

**Frontend**: Add an org switcher dropdown in the sidebar (below the org name). When the user switches orgs:

1. Call `switchOrg` mutation
2. Convex reactivity automatically refreshes all queries scoped to `user.orgId`
3. Tinybird JWT gets refreshed on next query (short TTL handles this naturally)

**Constraint**: Users who own an org can still switch away from it. Ownership is tracked in `organizations.ownerId` and `organizationMembers.role`, not in `users.orgId`.

### Impact on existing code

Most queries already go through `getCurrentUser(ctx)` and use `user.orgId` to scope data. This means org switching "just works" for:

- `subscriptions.getForCurrentUser`
- `subscriptions.getBillingSummaryForCurrentUser`
- `organizations.get`, `organizations.getMembers`
- `usage.getCurrentUsage`
- API key listing (if scoped by org)

The key architectural property is that `user.orgId` is the single source of truth for "what org is this user currently working in." All queries derive from it.

## Tinybird JWT Scoping Impact

### Current state

Tinybird JWTs are scoped by **individual user API keys** via `fixed_params.api_keys`. The `generateToken` action in `tinybird.ts`:

1. Fetches the current user's API keys via `apiKeys.listByUserId`
2. Embeds them as `api_keys` in JWT `fixed_params`
3. Tinybird queries filter rows by `ApiKey IN (api_keys)` -- row-level security

This means a user only sees traces from their own API keys, even within the same org.

### Problem with RBAC

When we add viewer/member roles, a viewer should see all org traces, not just traces from their own (nonexistent) API keys. The current per-user key scoping breaks this.

### Solution: Scope JWTs by org, not by user

Change `generateToken` to fetch **all org API keys** instead of just the user's keys:

```ts
// Current (user-scoped)
const apiKeys = await ctx.runQuery(internal.apiKeys.listByUserId, { userId });

// New (org-scoped)
const apiKeys = user?.orgId
  ? await ctx.runQuery(internal.apiKeys.listByOrgId, { orgId: user.orgId })
  : [];
```

`listByOrgId` already exists in `apiKeys.ts`. This change:

- Lets all org members (including viewers) see all org traces
- Is already how `extendRetention` works (it uses `listByOrgId`)
- Respects org switching -- when a user switches orgs, their next JWT will scope to the new org's keys
- Maintains the `__NO_KEYS__` sentinel when an org has no keys

### Retention scoping

Already org-aware. `generateToken` looks up the subscription tier via `user.orgId` and applies `RETENTION_DAYS[tier]` as `fixed_params.retention_days`. No changes needed.

### Migration

This is a **behavioral change** -- users currently only see their own traces. After the change, all org members see all org traces. This should be communicated as a feature (team visibility) but needs to ship alongside the RBAC roles so that viewer permissions are properly gated.

**Sequence**: Ship the org-scoped JWT change in the same release as RBAC Phase 3 (role-based action gating). This ensures viewers can see data but cannot create API keys or modify anything.

## Testing Considerations

Add to the subscriptions test plan:

- `requireOrgRole` unit tests covering all 4 roles against all 4 minimum levels (16 combinations)
- Non-member access: throws
- Inactive membership: throws
- Role hierarchy enforcement: member < admin, admin < owner, etc.
- Seat enforcement with pending invites included in count

## Risks

1. **Migration data integrity**: Existing `organizationMembers` rows have `role: 'owner' | 'member'`. Adding `admin` and `viewer` to the union is backward-compatible -- no existing rows need to change.
2. **Performance**: `requireOrgRole` adds one DB query (membership lookup) to every guarded function. This is an indexed query on `by_user_id` which is fast. The alternative of embedding role in the user document would create cross-org contamination.
3. **Platform admin vs org admin confusion**: Keeping these as separate systems (different fields, different helpers) prevents accidental privilege escalation. The naming makes it clear: `requireAdmin()` = platform, `requireOrgRole()` = org-scoped.
