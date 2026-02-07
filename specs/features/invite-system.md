# Invite System for Launch

## Overview

Implement an invite-only access system for the initial launch. This includes admin-controlled invites and a public waitlist for interested users.

## Current Auth Architecture

- **Auth provider**: Auth0 (via `workers/web/src/components/AuthButton.tsx`)
- **User storage**: Convex `users` table (via `convex/users.ts`)
- **User initialization**: `useInitializeUser` hook syncs Auth0 users to Convex

## Data Model

### New Tables in `convex/schema.ts`

```typescript
// Invites table
invites: defineTable({
  email: v.string(),
  invitedBy: v.id('users'),  // Admin who sent invite
  status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('expired')),
  token: v.string(),  // Unique token for invite URL
  createdAt: v.number(),
  acceptedAt: v.optional(v.number()),
  expiresAt: v.number(),  // 7 days from creation
})
  .index('by_email', ['email'])
  .index('by_token', ['token'])
  .index('by_status', ['status']),

// Waitlist table
waitlist: defineTable({
  email: v.string(),
  source: v.optional(v.string()),  // How they found us
  createdAt: v.number(),
  notifiedAt: v.optional(v.number()),  // When we last emailed them
})
  .index('by_email', ['email']),
```

### User Table Update

```typescript
users: defineTable({
  // ... existing fields
  inviteId: v.optional(v.id('invites')),  // Link to invite that got them in
  isAdmin: v.optional(v.boolean()),  // For admin access
}),
```

## Implementation

### 1. Invite Management (Admin)

**File**: `convex/invites.ts`

```typescript
export const createInvite = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireAdmin(ctx);

    // Check if already invited or on waitlist
    const existing = await ctx.db
      .query('invites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first();

    if (existing?.status === 'accepted') {
      throw new Error('User already accepted an invite');
    }

    const token = generateSecureToken(); // crypto.randomUUID()
    const inviteId = await ctx.db.insert('invites', {
      email,
      invitedBy: ctx.auth.getUserIdentity()?.userId,
      status: 'pending',
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    // Send invite email via action
    await ctx.scheduler.runAfter(0, internal.invites.sendInviteEmail, {
      inviteId,
      email,
      token,
    });

    return inviteId;
  },
});

export const listInvites = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return ctx.db.query('invites').order('desc').collect();
  },
});
```

**File**: `convex/invites.ts` (email action)

```typescript
export const sendInviteEmail = internalAction({
  args: { inviteId: v.id('invites'), email: v.string(), token: v.string() },
  handler: async (_, { email, token }) => {
    const inviteUrl = `${process.env.APP_URL}/invite/${token}`;

    // Use Resend or similar email service
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Trace Flow <hello@traceflow.dev>',
        to: email,
        subject: "You're invited to Trace Flow",
        html: `
          <h1>Welcome to Trace Flow!</h1>
          <p>You've been invited to join Trace Flow, the LLM observability platform.</p>
          <a href="${inviteUrl}">Accept Invite & Get Started</a>
          <p>This invite expires in 7 days.</p>
        `,
      }),
    });
  },
});
```

### 2. Invite Acceptance Flow

**File**: `convex/invites.ts`

```typescript
export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const invite = await ctx.db
      .query('invites')
      .withIndex('by_token', (q) => q.eq('token', token))
      .first();

    if (!invite) throw new Error('Invalid invite');
    if (invite.status === 'accepted') throw new Error('Invite already used');
    if (invite.expiresAt < Date.now()) throw new Error('Invite expired');

    // Mark invite as accepted
    await ctx.db.patch(invite._id, {
      status: 'accepted',
      acceptedAt: Date.now(),
    });

    // Return info needed for auth flow
    return { email: invite.email, inviteId: invite._id };
  },
});
```

**File**: `workers/web/src/pages/InviteAccept.tsx`

```typescript
export function InviteAccept() {
  const { token } = useParams();
  const acceptInvite = useMutation(api.invites.acceptInvite);
  const { loginWithRedirect } = useAuth0();

  useEffect(() => {
    async function accept() {
      try {
        const { email } = await acceptInvite({ token });
        // Redirect to Auth0 with email hint
        loginWithRedirect({
          authorizationParams: {
            login_hint: email,
            screen_hint: 'signup',
          },
        });
      } catch (error) {
        setError(error.message);
      }
    }
    accept();
  }, [token]);

  return <LoadingScreen message="Accepting invite..." />;
}
```

### 3. Access Control

**File**: `convex/users.ts`

Update user initialization to check invite status:

```typescript
export const initializeUser = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const email = identity.email;

    // Check for accepted invite
    const invite = await ctx.db
      .query('invites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .filter((q) => q.eq(q.field('status'), 'accepted'))
      .first();

    if (!invite) {
      throw new Error('No valid invite found. Please request access.');
    }

    // Create or update user
    // ... existing logic with invite linkage
  },
});
```

### 4. Waitlist

**File**: `convex/waitlist.ts`

```typescript
export const joinWaitlist = mutation({
  args: { email: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, { email, source }) => {
    // Validate email format
    if (!isValidEmail(email)) throw new Error('Invalid email');

    // Check if already on waitlist or invited
    const existing = await ctx.db
      .query('waitlist')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first();

    if (existing) return { status: 'already_registered' };

    await ctx.db.insert('waitlist', {
      email,
      source,
      createdAt: Date.now(),
    });

    return { status: 'success' };
  },
});
```

### 5. Landing Page Update

**File**: `workers/web/src/pages/Landing.tsx`

```typescript
export function Landing() {
  const [email, setEmail] = useState('');
  const joinWaitlist = useMutation(api.waitlist.joinWaitlist);
  const [submitted, setSubmitted] = useState(false);

  return (
    <div>
      <h1>Trace Flow</h1>
      <p>LLM Observability for Production AI</p>

      <div className="invite-banner">
        <p>We're currently invite-only while we iron out early bugs.</p>

        {submitted ? (
          <p className="success">You're on the list! We'll be in touch.</p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await joinWaitlist({ email, source: 'landing' });
              setSubmitted(true);
            }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
            />
            <button type="submit">Join Waitlist</button>
          </form>
        )}
      </div>
    </div>
  );
}
```

### 6. Admin UI

**File**: `workers/web/src/pages/AdminInvites.tsx`

Simple admin page to manage invites:

- List all invites with status
- Form to send new invite by email
- View waitlist entries
- Bulk invite from waitlist

## Email Provider Setup

Use **Resend** for transactional emails:

1. Create Resend account
2. Verify domain (traceflow.dev)
3. Add `RESEND_API_KEY` to Convex environment

## Routes

```typescript
// Public
<Route path="/invite/:token" element={<InviteAccept />} />

// Admin only
<Route path="/admin/invites" element={<AdminInvites />} />
```

## Acceptance Criteria

- [ ] Admin can send invites by email
- [ ] Invited users receive email with unique link
- [ ] Invite link leads to Auth0 signup with email pre-filled
- [ ] Only users with accepted invites can access the app
- [ ] Landing page shows invite-only status
- [ ] Waitlist signup form captures interested users
- [ ] Admin can view and manage waitlist
- [ ] Invites expire after 7 days
