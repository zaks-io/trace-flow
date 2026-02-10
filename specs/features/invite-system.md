# Invite System for Launch

## Overview

Implement an invite-only access system for the initial launch. This includes admin-controlled invites and a public waitlist with email confirmation for interested users.

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
  confirmed: v.boolean(),  // false until email verified
  confirmationToken: v.string(),  // Unique token for confirmation URL
  notifiedAt: v.optional(v.number()),  // When we last emailed them
})
  .index('by_email', ['email'])
  .index('by_confirmation_token', ['confirmationToken']),
```

### User Table Update

```typescript
users: defineTable({
  // ... existing fields
  inviteId: v.optional(v.id('invites')),  // Link to invite that got them in
  isAdmin: v.optional(v.boolean()),  // For admin access
}),
```

## Email Templates

Use **React Email** (`@react-email/components`) (https://react.email/docs/introduction) for type-safe, component-based email templates. The Resend SDK accepts React Email components directly.

### Package Setup

**New package**: `packages/emails/`

```json
{
  "name": "@trace-flow/emails",
  "dependencies": {
    "@react-email/components": "latest",
    "resend": "latest"
  },
  "devDependencies": {
    "react-email": "latest"
  },
  "scripts": {
    "dev": "email dev"
  }
}
```

### Templates

**File**: `packages/emails/src/invite.tsx`

```tsx
import { Html, Head, Body, Container, Heading, Text, Link, Preview } from '@react-email/components';

interface InviteEmailProps {
  inviteUrl: string;
}

export function InviteEmail({ inviteUrl }: InviteEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>You've been invited to Trace Flow</Preview>
      <Body>
        <Container>
          <Heading>Welcome to Trace Flow!</Heading>
          <Text>You've been invited to join Trace Flow, the LLM observability platform.</Text>
          <Link href={inviteUrl}>Accept Invite & Get Started</Link>
          <Text>This invite expires in 7 days.</Text>
        </Container>
      </Body>
    </Html>
  );
}
```

**File**: `packages/emails/src/waitlist-confirmation.tsx`

```tsx
import { Html, Head, Body, Container, Heading, Text, Link, Preview } from '@react-email/components';

interface WaitlistConfirmationEmailProps {
  confirmUrl: string;
}

export function WaitlistConfirmationEmail({ confirmUrl }: WaitlistConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Confirm your spot on the Trace Flow waitlist</Preview>
      <Body>
        <Container>
          <Heading>Confirm your email</Heading>
          <Text>
            Thanks for your interest in Trace Flow! Please confirm your email to secure your spot on
            our waitlist.
          </Text>
          <Link href={confirmUrl}>Confirm Email</Link>
        </Container>
      </Body>
    </Html>
  );
}
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
      invitedBy: adminUser._id, // Query for admin user doc first
      status: 'pending',
      token,
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
import { Resend } from 'resend';
import { InviteEmail } from '@trace-flow/emails';

export const sendInviteEmail = internalAction({
  args: { inviteId: v.id('invites'), email: v.string(), token: v.string() },
  handler: async (_, { email, token }) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const inviteUrl = `${process.env.APP_URL}/invite/${token}`;

    await resend.emails.send({
      from: 'Trace Flow <hello@traceflow.dev>',
      to: email,
      subject: "You're invited to Trace Flow",
      react: InviteEmail({ inviteUrl }),
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
    if (!isValidEmail(email)) throw new Error('Invalid email');

    const existing = await ctx.db
      .query('waitlist')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first();

    if (existing?.confirmed) return { status: 'already_registered' };

    // If unconfirmed entry exists, resend confirmation email
    if (existing) {
      await ctx.scheduler.runAfter(0, internal.waitlist.sendConfirmationEmail, {
        email,
        token: existing.confirmationToken,
      });
      return { status: 'confirmation_sent' };
    }

    const confirmationToken = crypto.randomUUID();
    await ctx.db.insert('waitlist', {
      email,
      source,
      confirmed: false,
      confirmationToken,
    });

    await ctx.scheduler.runAfter(0, internal.waitlist.sendConfirmationEmail, {
      email,
      token: confirmationToken,
    });

    return { status: 'confirmation_sent' };
  },
});

export const confirmEmail = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const entry = await ctx.db
      .query('waitlist')
      .withIndex('by_confirmation_token', (q) => q.eq('confirmationToken', token))
      .first();

    if (!entry) throw new Error('Invalid confirmation link');
    if (entry.confirmed) return { status: 'already_confirmed', email: entry.email };

    await ctx.db.patch(entry._id, { confirmed: true });
    return { status: 'confirmed', email: entry.email };
  },
});
```

**File**: `convex/waitlist.ts` (email action)

```typescript
import { Resend } from 'resend';
import { WaitlistConfirmationEmail } from '@trace-flow/emails';

export const sendConfirmationEmail = internalAction({
  args: { email: v.string(), token: v.string() },
  handler: async (_, { email, token }) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const confirmUrl = `${process.env.APP_URL}/waitlist/confirm/${token}`;

    await resend.emails.send({
      from: 'Trace Flow <hello@traceflow.dev>',
      to: email,
      subject: 'Confirm your spot on the Trace Flow waitlist',
      react: WaitlistConfirmationEmail({ confirmUrl }),
    });
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
          <p className="success">Check your email to confirm your spot on the waitlist.</p>
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
- View waitlist entries with confirmed/unconfirmed status
- Bulk invite from waitlist (only confirmed entries eligible)

## Email Provider Setup

Use **Resend** for transactional emails with **React Email** for templates:

1. Create Resend account
2. Verify domain (traceflow.dev)
3. Add `RESEND_API_KEY` to Convex environment
4. Add `APP_URL` to Convex environment
5. Preview templates locally: `cd packages/emails && bun run dev`

## Routes

```typescript
// Public
<Route path="/invite/:token" element={<InviteAccept />} />
<Route path="/waitlist/confirm/:token" element={<WaitlistConfirm />} />

// Admin only
<Route path="/admin/invites" element={<AdminInvites />} />
```

### Waitlist Confirmation Page

**File**: `workers/web/src/pages/WaitlistConfirm.tsx`

```typescript
export function WaitlistConfirm() {
  const { token } = useParams();
  const confirmEmail = useMutation(api.waitlist.confirmEmail);
  const [result, setResult] = useState<{ status: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function confirm() {
      try {
        const res = await confirmEmail({ token });
        setResult(res);
      } catch (err) {
        setError(err.message);
      }
    }
    confirm();
  }, [token]);

  if (error) return <p>Something went wrong: {error}</p>;
  if (!result) return <LoadingScreen message="Confirming your email..." />;

  return (
    <div>
      <h1>You're on the list!</h1>
      <p>We've confirmed {result.email}. We'll reach out when it's your turn.</p>
    </div>
  );
}
```

## Acceptance Criteria

- [ ] Admin can send invites by email
- [ ] Invited users receive email with unique link
- [ ] Invite link leads to Auth0 signup with email pre-filled
- [ ] Only users with accepted invites can access the app
- [ ] Landing page shows invite-only status
- [ ] Waitlist signup sends confirmation email
- [ ] Waitlist entry is only confirmed after clicking email link
- [ ] Resubmitting an unconfirmed email resends the confirmation
- [ ] Admin waitlist view shows confirmation status
- [ ] Only confirmed waitlist entries are eligible for bulk invite
- [ ] Invites expire after 7 days
