# User Signup and Onboarding Flow

## Overview

Implement a guided onboarding experience for new users after they accept an invite and create an account.

## Current State

- Auth handled by Auth0 (existing)
- User record created in Convex on first login (existing)
- No guided onboarding or setup wizard

## Onboarding Flow

```
+--------------+    +--------------+    +--------------+    +--------------+
|   Welcome    | -> |   Create     | -> |    Send      | -> |    View      |
|   Screen     |    |   API Key    |    |   Request    |    |   Trace!     |
+--------------+    +--------------+    +--------------+    +--------------+
```

### Step 1: Welcome Screen

- Greet user by name (from Auth0 profile)
- Brief explanation of Trace Flow's value
- "Get Started" button

### Step 2: Create API Key

- Auto-generate first API key
- Show the key with copy button
- Explain that this key goes in their application
- Link to docs for supported providers

### Step 3: Send First Request

- Show code snippet for making a proxied request
- Real-time listener waiting for first trace
- "Skip for now" option

### Step 4: View First Trace

- If trace received, show success with link to view it
- Explain key features (Gantt chart, token breakdown, etc.)
- "Go to Dashboard" to complete onboarding

## Data Model

Add onboarding tracking to users table:

```typescript
users: defineTable({
  // ... existing fields
  onboardingStatus: v.optional(
    v.union(
      v.literal('not_started'),
      v.literal('api_key_created'),
      v.literal('first_request_sent'),
      v.literal('completed')
    )
  ),
  onboardingCompletedAt: v.optional(v.number()),
}),
```

## Implementation

### 1. Onboarding State Management

**File**: `convex/onboarding.ts`

```typescript
export const getOnboardingStatus = query({
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return {
      status: user?.onboardingStatus ?? 'not_started',
      hasApiKeys: await hasAnyApiKeys(ctx, user._id),
      hasTraces: await hasAnyTraces(ctx, user._id),
    };
  },
});

export const updateOnboardingStatus = mutation({
  args: { status: v.string() },
  handler: async (ctx, { status }) => {
    const user = await getCurrentUser(ctx);
    await ctx.db.patch(user._id, {
      onboardingStatus: status,
      ...(status === 'completed' ? { onboardingCompletedAt: Date.now() } : {}),
    });
  },
});
```

### 2. Onboarding Wrapper

**File**: `apps/web/src/components/OnboardingGuard.tsx`

```typescript
export function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const status = useQuery(api.onboarding.getOnboardingStatus);

  if (status === undefined) return <Loading />;

  if (status.status !== 'completed') {
    return <OnboardingWizard initialStatus={status} />;
  }

  return <>{children}</>;
}
```

### 3. Onboarding Wizard Component

**File**: `apps/web/src/components/OnboardingWizard.tsx`

```typescript
export function OnboardingWizard({ initialStatus }) {
  const [step, setStep] = useState(getInitialStep(initialStatus));
  const updateStatus = useMutation(api.onboarding.updateOnboardingStatus);

  const steps = [
    { id: 'welcome', component: WelcomeStep },
    { id: 'api-key', component: ApiKeyStep },
    { id: 'first-request', component: FirstRequestStep },
    { id: 'complete', component: CompleteStep },
  ];

  const CurrentStep = steps[step].component;

  return (
    <div className="onboarding-container">
      <ProgressIndicator current={step} total={steps.length} />
      <CurrentStep
        onNext={() => {
          updateStatus({ status: getStatusForStep(step + 1) });
          setStep(step + 1);
        }}
        onSkip={() => {
          updateStatus({ status: 'completed' });
        }}
      />
    </div>
  );
}
```

### 4. Welcome Step

**File**: `apps/web/src/components/onboarding/WelcomeStep.tsx`

```typescript
export function WelcomeStep({ onNext }) {
  const user = useQuery(api.users.getCurrentUserQuery);

  return (
    <div className="text-center space-y-6">
      <h1 className="text-3xl font-bold">
        Welcome to Trace Flow{user?.name ? `, ${user.name}` : ''}!
      </h1>
      <p className="text-muted-foreground max-w-md mx-auto">
        Trace Flow helps you understand what's happening inside your AI applications. See every
        LLM call, track costs, and debug issues in real-time.
      </p>
      <Button size="lg" onClick={onNext}>
        Get Started
      </Button>
    </div>
  );
}
```

### 5. API Key Step

**File**: `apps/web/src/components/onboarding/ApiKeyStep.tsx`

```typescript
export function ApiKeyStep({ onNext }) {
  const createApiKey = useMutation(api.apiKeys.create);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    createApiKey({ name: 'My First Key' }).then(setApiKey);
  }, []);

  return (
    <div className="space-y-6">
      <h2>Your API Key</h2>
      <p>Use this key to send requests through Trace Flow:</p>

      {apiKey ? (
        <div className="bg-muted p-4 rounded-lg font-mono flex justify-between">
          <span>{apiKey}</span>
          <Button
            variant="ghost"
            onClick={() => {
              navigator.clipboard.writeText(apiKey);
              setCopied(true);
            }}
          >
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
      ) : (
        <Skeleton className="h-12" />
      )}

      <Alert>
        <AlertDescription>
          Save this key somewhere safe. You won't be able to see it again.
        </AlertDescription>
      </Alert>

      <Button onClick={onNext} disabled={!apiKey}>
        Continue
      </Button>
    </div>
  );
}
```

### 6. First Request Step

**File**: `apps/web/src/components/onboarding/FirstRequestStep.tsx`

```typescript
export function FirstRequestStep({ onNext, onSkip }) {
  const { data: traces, isLoading } = useTinybirdQuery('traces_list', { limit: 1 });
  const hasTrace = traces?.length > 0;

  useEffect(() => {
    if (hasTrace) onNext();
  }, [hasTrace]);

  const codeSnippet = `
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'https://proxy.traceflow.dev/anthropic',
  defaultHeaders: {
    'X-Traceflow-Key': 'YOUR_API_KEY',
  },
});

const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
  `.trim();

  return (
    <div className="space-y-6">
      <h2>Send Your First Request</h2>
      <p>Point your LLM SDK at our proxy to start tracing:</p>

      <CodeBlock language="typescript" code={codeSnippet} />

      <div className="flex items-center gap-2 text-muted-foreground">
        {isLoading ? (
          <>
            <Loader2 className="animate-spin" />
            <span>Waiting for your first request...</span>
          </>
        ) : (
          <span>No requests yet</span>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onSkip}>
          Skip for now
        </Button>
        <Button variant="link" asChild>
          <a href="/docs/quickstart">View Documentation</a>
        </Button>
      </div>
    </div>
  );
}
```

### 7. Complete Step

**File**: `apps/web/src/components/onboarding/CompleteStep.tsx`

```typescript
export function CompleteStep() {
  const navigate = useNavigate();

  return (
    <div className="text-center space-y-6">
      <div className="text-6xl">Success!</div>
      <h2>You're All Set!</h2>
      <p>Your traces will appear in the dashboard as requests come in.</p>

      <div className="flex gap-4 justify-center">
        <Button onClick={() => navigate('/dashboard')}>Go to Dashboard</Button>
        <Button variant="outline" onClick={() => navigate('/docs')}>
          Read the Docs
        </Button>
      </div>
    </div>
  );
}
```

## Integration Points

### App Layout

**File**: `apps/web/src/components/AppLayout.tsx`

Wrap authenticated content with onboarding guard:

```typescript
export function AppLayout() {
  return (
    <AuthGuard>
      <OnboardingGuard>{/* existing layout */}</OnboardingGuard>
    </AuthGuard>
  );
}
```

## Acceptance Criteria

- [ ] New users see welcome screen on first login
- [ ] API key is auto-generated and displayed clearly
- [ ] Code snippet shows how to use the proxy
- [ ] Real-time detection when first trace arrives
- [ ] Option to skip and complete onboarding later
- [ ] Onboarding state persists across sessions
- [ ] Users who complete onboarding go directly to dashboard
