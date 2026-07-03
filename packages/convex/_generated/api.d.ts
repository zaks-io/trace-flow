/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  admin: {
    admin: {
      deleteOrgData: FunctionReference<
        "action",
        "public",
        { orgId: Id<"organizations"> },
        {
          convexDeleted: {
            addonPurchases: number;
            alerts: number;
            apiKeys: number;
            invites: number;
            mcpRefreshTokens: number;
            mcpSessions: number;
            membersRemoved: number;
            usage: number;
          };
          stripeCanceled: boolean;
          tinybirdResults:
            | { deleted: false; reason: string }
            | {
                deleted: true;
                results: Record<string, { error?: string; success: boolean }>;
              };
        }
      >;
      forceActivateAndVerify: FunctionReference<
        "action",
        "public",
        {
          monthlyUnits?: number;
          orgId: Id<"organizations">;
          periodDays?: number;
          tier?: "hobby" | "pro";
        },
        { kvVerified: boolean; success: boolean }
      >;
      listOrgs: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          _creationTime: number;
          _id: Id<"organizations">;
          deletedAt?: number;
          name: string;
          onboardingCompletedAt?: number;
          ownerId: Id<"users">;
          stripeCustomerId?: string;
        }>
      >;
      listOrgSubscriptionHealth: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          _id: Id<"organizations">;
          issues: Array<
            "no_subscription" | "period_expired" | "suspended" | "canceled"
          >;
          name: string;
          ownerEmail?: string;
          subscription: null | {
            _id: Id<"subscriptions">;
            addonUnits: number;
            currentPeriodEnd: number;
            currentPeriodStart: number;
            monthlyUnits: number;
            status: "active" | "grace" | "suspended" | "canceled";
            stripeSubscriptionId?: string;
            tier: "hobby" | "pro";
          };
        }>
      >;
      stats: FunctionReference<
        "query",
        "public",
        {},
        {
          apiKeyCount: number;
          modelPricingCount: number;
          orgCount: number;
          subscriptionCount: number;
          tierBreakdown: { hobby: number; pro: number };
          userCount: number;
        }
      >;
    };
    adminAnalytics: {
      exportExplorerCsv: FunctionReference<
        "action",
        "public",
        {
          endTimeMs: number;
          isSse?: "0" | "1";
          limit?: number;
          model?: string;
          operation?: string;
          orgId?: string;
          provider?: string;
          skipReason?: string;
          startTimeMs: number;
          statusCode?: string;
        },
        { csv: string; filename: string; rowCount: number }
      >;
      getDashboard: FunctionReference<
        "action",
        "public",
        {
          endTimeMs: number;
          isSse?: "0" | "1";
          model?: string;
          operation?: string;
          orgId?: string;
          provider?: string;
          skipReason?: string;
          startTimeMs: number;
          statusCode?: string;
        },
        {
          breakdowns: {
            model: Array<{
              dimension: string;
              p95LatencyMs: number;
              requestCount: number;
              responseBytes: number;
              serverErrorCount: number;
              serverErrorRate: number;
              skipCount: number;
              skipRate: number;
              totalTokens: number;
            }>;
            operation: Array<{
              dimension: string;
              p95LatencyMs: number;
              requestCount: number;
              responseBytes: number;
              serverErrorCount: number;
              serverErrorRate: number;
              skipCount: number;
              skipRate: number;
              totalTokens: number;
            }>;
            orgId: Array<{
              dimension: string;
              p95LatencyMs: number;
              requestCount: number;
              responseBytes: number;
              serverErrorCount: number;
              serverErrorRate: number;
              skipCount: number;
              skipRate: number;
              totalTokens: number;
            }>;
            provider: Array<{
              dimension: string;
              p95LatencyMs: number;
              requestCount: number;
              responseBytes: number;
              serverErrorCount: number;
              serverErrorRate: number;
              skipCount: number;
              skipRate: number;
              totalTokens: number;
            }>;
            skipReason: Array<{
              dimension: string;
              p95LatencyMs: number;
              requestCount: number;
              responseBytes: number;
              serverErrorCount: number;
              serverErrorRate: number;
              skipCount: number;
              skipRate: number;
              totalTokens: number;
            }>;
            statusCode: Array<{
              dimension: string;
              p95LatencyMs: number;
              requestCount: number;
              responseBytes: number;
              serverErrorCount: number;
              serverErrorRate: number;
              skipCount: number;
              skipRate: number;
              totalTokens: number;
            }>;
          };
          dataset: string;
          filterOptions: {
            models: Array<string>;
            operations: Array<string>;
            orgIds: Array<string>;
            providers: Array<string>;
            skipReasons: Array<string>;
            statusCodes: Array<string>;
          };
          granularity: string;
          summary: {
            avgLatencyMs: number;
            avgTtfbMs: number;
            cacheReadTokens: number;
            completionTokens: number;
            p50LatencyMs: number;
            p95LatencyMs: number;
            p95TtfbMs: number;
            p99LatencyMs: number;
            promptTokens: number;
            requestCount: number;
            responseBytes: number;
            serverErrorCount: number;
            serverErrorRate: number;
            skipCount: number;
            skipRate: number;
            totalTokens: number;
          };
          timeseries: Array<{
            bucket: string;
            p95LatencyMs: number;
            p95TtfbMs: number;
            requestCount: number;
            responseBytes: number;
            serverErrorRate: number;
            skipRate: number;
            totalTokens: number;
          }>;
        }
      >;
      getExplorerRows: FunctionReference<
        "action",
        "public",
        {
          endTimeMs: number;
          isSse?: "0" | "1";
          limit?: number;
          model?: string;
          offset?: number;
          operation?: string;
          orgId?: string;
          provider?: string;
          skipReason?: string;
          startTimeMs: number;
          statusCode?: string;
        },
        {
          columns: Array<{ name: string; type: string }>;
          hasMore: boolean;
          limit: number;
          offset: number;
          rows: Array<{
            cacheReadTokens: number;
            completionTokens: number;
            isServerError: number;
            isSse: string;
            model: string;
            operation: string;
            orgId: string;
            prepLatencyMs: number;
            promptTokens: number;
            provider: string;
            responseBytes: number;
            sampleInterval: number;
            skipReason: string;
            statusCode: string;
            timestamp: string;
            totalLatencyMs: number;
            totalTokens: number;
            ttfbMs: number;
          }>;
          sql: string;
        }
      >;
      runAdvancedQuery: FunctionReference<
        "action",
        "public",
        { endTimeMs: number; limit?: number; sql: string; startTimeMs: number },
        {
          columns: Array<{ name: string; type: string }>;
          rowCount: number;
          rows: Array<Array<string>>;
          sql: string;
        }
      >;
    };
  };
  alerts: {
    create: FunctionReference<
      "mutation",
      "public",
      {
        field:
          | "duration_ms"
          | "tokens_per_second"
          | "total_tokens"
          | "prompt_tokens"
          | "completion_tokens"
          | "ttft_ms"
          | "is_error"
          | "http_status_code"
          | "cost_total";
        name: string;
        operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
        severity: "info" | "warning" | "error";
        value: number | string | boolean;
      },
      any
    >;
    list: FunctionReference<"query", "public", any, any>;
    listEnabled: FunctionReference<"query", "public", any, any>;
    remove: FunctionReference<"mutation", "public", { id: Id<"alerts"> }, any>;
    toggle: FunctionReference<"mutation", "public", { id: Id<"alerts"> }, any>;
    update: FunctionReference<
      "mutation",
      "public",
      {
        field?:
          | "duration_ms"
          | "tokens_per_second"
          | "total_tokens"
          | "prompt_tokens"
          | "completion_tokens"
          | "ttft_ms"
          | "is_error"
          | "http_status_code"
          | "cost_total";
        id: Id<"alerts">;
        name?: string;
        operator?: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
        severity?: "info" | "warning" | "error";
        value?: number | string | boolean;
      },
      any
    >;
  };
  analyst: {
    conversationUsageSummary: FunctionReference<
      "query",
      "public",
      { threadId: Id<"analystThreads"> },
      any
    >;
    listMessages: FunctionReference<
      "query",
      "public",
      {
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        streamArgs?:
          | { kind: "list"; startOrder?: number }
          | {
              cursors: Array<{ cursor: number; streamId: string }>;
              kind: "deltas";
            };
        threadId: Id<"analystThreads">;
      },
      any
    >;
    listThreads: FunctionReference<"query", "public", {}, any>;
    sendMessage: FunctionReference<
      "action",
      "public",
      {
        pageContextReferences?: Array<{
          filters?: Record<string, string | number | boolean | null>;
          label: string;
          objectId: string;
          route: string;
          surface: "agents";
        }>;
        prompt: string;
        threadId?: Id<"analystThreads">;
      },
      any
    >;
    stopRun: FunctionReference<
      "action",
      "public",
      { threadId: Id<"analystThreads"> },
      any
    >;
  };
  analystSandbox: {
    cancelSandboxRun: FunctionReference<
      "action",
      "public",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    checkpointSandboxRun: FunctionReference<
      "action",
      "public",
      {
        backup: { dir: string; id: string; localBucket?: boolean };
        runId: Id<"analystSandboxRuns">;
        token: string;
      },
      any
    >;
    cleanupSandboxRunContainer: FunctionReference<
      "action",
      "public",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    completeSandboxRun: FunctionReference<
      "action",
      "public",
      {
        backup?: { dir: string; id: string; localBucket?: boolean };
        error?: string;
        resultText?: string;
        runId: Id<"analystSandboxRuns">;
        status: "completed" | "failed" | "timed_out" | "cancelled";
        token: string;
      },
      any
    >;
    executeSandboxToolCall: FunctionReference<
      "action",
      "public",
      {
        arguments?: any;
        runId: Id<"analystSandboxRuns">;
        token: string;
        toolName: string;
      },
      any
    >;
    getSandboxRun: FunctionReference<
      "query",
      "public",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    listSandboxRunEvents: FunctionReference<
      "query",
      "public",
      { afterSeq?: number; limit?: number; runId: Id<"analystSandboxRuns"> },
      any
    >;
    listSandboxRunRows: FunctionReference<
      "query",
      "public",
      { limit?: number; runId: Id<"analystSandboxRuns"> },
      any
    >;
    listSandboxRuns: FunctionReference<
      "query",
      "public",
      { threadId: Id<"analystThreads"> },
      any
    >;
    receiveSandboxEvents: FunctionReference<
      "action",
      "public",
      {
        events: Array<{
          data?: any;
          emittedAt?: number;
          message?: string;
          type:
            | "status"
            | "stdout"
            | "stderr"
            | "message"
            | "tool_call"
            | "tool_result"
            | "result"
            | "error"
            | "control"
            | "usage";
        }>;
        runId: Id<"analystSandboxRuns">;
        token: string;
      },
      any
    >;
    refreshSandboxRunStatus: FunctionReference<
      "action",
      "public",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    verifySandboxRunToken: FunctionReference<
      "action",
      "public",
      { runId: Id<"analystSandboxRuns">; token: string },
      any
    >;
  };
  apiKeys: {
    create: FunctionReference<
      "mutation",
      "public",
      { expiresAt: number; name?: string },
      Id<"apiKeys">
    >;
    getByKey: FunctionReference<
      "query",
      "public",
      { key: string },
      null | {
        _creationTime: number;
        _id: Id<"apiKeys">;
        expiresAt: number;
        key: string;
        name?: string;
        orgId?: Id<"organizations">;
        userId?: Id<"users">;
      }
    >;
    list: FunctionReference<
      "query",
      "public",
      {},
      Array<{
        _creationTime: number;
        _id: Id<"apiKeys">;
        expiresAt: number;
        key: string;
        name?: string;
        orgId?: Id<"organizations">;
        userId?: Id<"users">;
      }>
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { id: Id<"apiKeys"> },
      null
    >;
    syncToKV: FunctionReference<
      "action",
      "public",
      { id: Id<"apiKeys"> },
      { existed: boolean; synced: boolean }
    >;
    update: FunctionReference<
      "mutation",
      "public",
      { expiresAt?: number; id: Id<"apiKeys">; name?: string },
      null
    >;
  };
  app: {
    sessionContext: FunctionReference<
      "query",
      "public",
      {},
      {
        isAdmin: boolean;
        onboardingCompletedAt?: number;
        subscription: {
          _creationTime: number;
          _id: Id<"subscriptions">;
          addonPurchaseCount: number;
          addonUnits: number;
          autoOverage?: boolean;
          autoTopupPendingSince?: number;
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd: number;
          currentPeriodOverageSpentCents: number;
          currentPeriodStart: number;
          deletionSchedulerId?: Id<"_scheduled_functions">;
          gracePeriodSchedulerId?: Id<"_scheduled_functions">;
          monthlyUnits: number;
          orgId: Id<"organizations">;
          overageCapCents?: number;
          status: "active" | "grace" | "suspended" | "canceled";
          stripeCustomerId?: string;
          stripePlanItemId?: string;
          stripeSubscriptionId?: string;
          tier: "hobby" | "pro";
        } | null;
        user: {
          _creationTime: number;
          _id: Id<"users">;
          email: string;
          enabled: boolean;
          inviteId?: Id<"invites">;
          isAdmin?: boolean;
          name?: string;
          orgId?: Id<"organizations">;
          picture?: string;
          tokenIdentifier: string;
        } | null;
      }
    >;
  };
  auth: {
    auth: {
      isAuthenticatedQuery: FunctionReference<"query", "public", {}, boolean>;
    };
    invites: {
      acceptInvite: FunctionReference<
        "mutation",
        "public",
        { token: string },
        { email: string }
      >;
      createInvite: FunctionReference<
        "mutation",
        "public",
        { email: string },
        Id<"invites">
      >;
      createOrgInvite: FunctionReference<
        "mutation",
        "public",
        { email: string },
        Id<"invites">
      >;
      getInviteByToken: FunctionReference<
        "query",
        "public",
        { token: string },
        null | { email?: string; status: "pending" | "accepted" | "expired" }
      >;
      listInvites: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          _creationTime: number;
          _id: Id<"invites">;
          acceptedAt?: number;
          email: string;
          expiresAt: number;
          invitedBy: Id<"users">;
          orgId?: Id<"organizations">;
          status: "pending" | "accepted" | "expired";
          token: string;
        }>
      >;
      revokeInvite: FunctionReference<
        "mutation",
        "public",
        { inviteId: Id<"invites"> },
        null
      >;
    };
    organizations: {
      completeOnboarding: FunctionReference<"mutation", "public", {}, null>;
      get: FunctionReference<
        "query",
        "public",
        {},
        null | {
          _creationTime: number;
          _id: Id<"organizations">;
          deletedAt?: number;
          name: string;
          onboardingCompletedAt?: number;
          ownerId: Id<"users">;
          stripeCustomerId?: string;
        }
      >;
      getMembers: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          _creationTime: number;
          _id: Id<"organizationMembers">;
          invitedAt?: number;
          joinedAt?: number;
          orgId: Id<"organizations">;
          removedAt?: number;
          role: "owner" | "member";
          status: "active" | "removed";
          userId: Id<"users">;
        }>
      >;
      rename: FunctionReference<"mutation", "public", { name: string }, null>;
    };
    users: {
      getCurrentUserQuery: FunctionReference<
        "query",
        "public",
        {},
        {
          _creationTime: number;
          _id: Id<"users">;
          email: string;
          enabled: boolean;
          inviteId?: Id<"invites">;
          isAdmin?: boolean;
          name?: string;
          orgId?: Id<"organizations">;
          picture?: string;
          tokenIdentifier: string;
        } | null
      >;
      getUser: FunctionReference<
        "query",
        "public",
        { id: Id<"users"> },
        {
          _creationTime: number;
          _id: Id<"users">;
          email: string;
          enabled: boolean;
          inviteId?: Id<"invites">;
          isAdmin?: boolean;
          name?: string;
          orgId?: Id<"organizations">;
          picture?: string;
          tokenIdentifier: string;
        } | null
      >;
      initializeUser: FunctionReference<
        "mutation",
        "public",
        {},
        { userId: Id<"users"> }
      >;
      isAdmin: FunctionReference<"query", "public", {}, boolean>;
      removeMember: FunctionReference<
        "mutation",
        "public",
        { memberId: Id<"organizationMembers"> },
        null
      >;
    };
  };
  billing: {
    modelPricing: {
      get: FunctionReference<
        "query",
        "public",
        { model: string; provider: string },
        {
          _creationTime: number;
          _id: Id<"modelPricing">;
          cacheReadCostPerMillion?: number;
          cacheWrite1hCostPerMillion?: number;
          cacheWriteCostPerMillion?: number;
          completionCostPerMillion: number;
          contextTier?: {
            cacheReadCostPerMillion?: number;
            cacheWrite1hCostPerMillion?: number;
            cacheWriteCostPerMillion?: number;
            completionCostPerMillion: number;
            promptCostPerMillion: number;
            reasoningCostPerMillion?: number;
            thresholdTokens: number;
          };
          model: string;
          promptCostPerMillion: number;
          provider: string;
          reasoningCostPerMillion?: number;
          source: "manual" | "openrouter" | "default" | "models.dev";
          updatedAt: number;
        } | null
      >;
      importFromModelsDev: FunctionReference<
        "action",
        "public",
        {},
        { imported: number; skipped: number }
      >;
      importFromOpenRouter: FunctionReference<
        "action",
        "public",
        {},
        { imported: number }
      >;
      list: FunctionReference<
        "query",
        "public",
        { provider?: string },
        Array<{
          _creationTime: number;
          _id: Id<"modelPricing">;
          cacheReadCostPerMillion?: number;
          cacheWrite1hCostPerMillion?: number;
          cacheWriteCostPerMillion?: number;
          completionCostPerMillion: number;
          contextTier?: {
            cacheReadCostPerMillion?: number;
            cacheWrite1hCostPerMillion?: number;
            cacheWriteCostPerMillion?: number;
            completionCostPerMillion: number;
            promptCostPerMillion: number;
            reasoningCostPerMillion?: number;
            thresholdTokens: number;
          };
          model: string;
          promptCostPerMillion: number;
          provider: string;
          reasoningCostPerMillion?: number;
          source: "manual" | "openrouter" | "default" | "models.dev";
          updatedAt: number;
        }>
      >;
      remove: FunctionReference<
        "mutation",
        "public",
        { id: Id<"modelPricing"> },
        null
      >;
      syncAllToKV: FunctionReference<
        "action",
        "public",
        {},
        { synced: number }
      >;
      syncDefaults: FunctionReference<
        "action",
        "public",
        {},
        { synced: number }
      >;
      upsert: FunctionReference<
        "mutation",
        "public",
        {
          cacheReadCostPerMillion?: number;
          cacheWrite1hCostPerMillion?: number;
          cacheWriteCostPerMillion?: number;
          completionCostPerMillion: number;
          contextTier?: {
            cacheReadCostPerMillion?: number;
            cacheWrite1hCostPerMillion?: number;
            cacheWriteCostPerMillion?: number;
            completionCostPerMillion: number;
            promptCostPerMillion: number;
            reasoningCostPerMillion?: number;
            thresholdTokens: number;
          };
          model: string;
          promptCostPerMillion: number;
          provider: string;
          reasoningCostPerMillion?: number;
          source: "manual" | "openrouter" | "default" | "models.dev";
        },
        Id<"modelPricing">
      >;
    };
    subscriptions: {
      createAddonCheckoutSession: FunctionReference<
        "action",
        "public",
        { cancelUrl?: string; quantity: number; successUrl?: string },
        { url: string | null }
      >;
      createBillingPortalSession: FunctionReference<
        "action",
        "public",
        { returnUrl?: string },
        { url: string }
      >;
      createOrgCheckoutSession: FunctionReference<
        "action",
        "public",
        { cancelUrl?: string; successUrl?: string },
        { url: string | null }
      >;
      ensureBillingForCurrentUser: FunctionReference<
        "mutation",
        "public",
        {},
        null
      >;
      getBillingSummaryForCurrentUser: FunctionReference<
        "query",
        "public",
        {},
        null | {
          currentPeriodEnd: number;
          remaining: number;
          role: "owner" | "member";
          subscription: {
            _creationTime: number;
            _id: Id<"subscriptions">;
            addonPurchaseCount: number;
            addonUnits: number;
            autoOverage?: boolean;
            autoTopupPendingSince?: number;
            cancelAtPeriodEnd?: boolean;
            currentPeriodEnd: number;
            currentPeriodOverageSpentCents: number;
            currentPeriodStart: number;
            deletionSchedulerId?: Id<"_scheduled_functions">;
            gracePeriodSchedulerId?: Id<"_scheduled_functions">;
            monthlyUnits: number;
            orgId: Id<"organizations">;
            overageCapCents?: number;
            status: "active" | "grace" | "suspended" | "canceled";
            stripeCustomerId?: string;
            stripePlanItemId?: string;
            stripeSubscriptionId?: string;
            tier: "hobby" | "pro";
          };
          totalAvailable: number;
          totalUsed: number;
        }
      >;
      getForCurrentUser: FunctionReference<
        "query",
        "public",
        {},
        null | {
          _creationTime: number;
          _id: Id<"subscriptions">;
          addonPurchaseCount: number;
          addonUnits: number;
          autoOverage?: boolean;
          autoTopupPendingSince?: number;
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd: number;
          currentPeriodOverageSpentCents: number;
          currentPeriodStart: number;
          deletionSchedulerId?: Id<"_scheduled_functions">;
          gracePeriodSchedulerId?: Id<"_scheduled_functions">;
          monthlyUnits: number;
          orgId: Id<"organizations">;
          overageCapCents?: number;
          status: "active" | "grace" | "suspended" | "canceled";
          stripeCustomerId?: string;
          stripePlanItemId?: string;
          stripeSubscriptionId?: string;
          tier: "hobby" | "pro";
        }
      >;
      reconcileCurrentOrgWithStripe: FunctionReference<
        "action",
        "public",
        {},
        { reason: string; reconciled: false } | { reconciled: true }
      >;
      updateAutoOverageSettings: FunctionReference<
        "mutation",
        "public",
        { autoOverage: boolean; overageCapCents?: number },
        null
      >;
    };
    usage: {
      getCurrentUsage: FunctionReference<
        "query",
        "public",
        {},
        {
          _creationTime: number;
          _id: Id<"usage">;
          addonUnitsUsed: number;
          orgId: Id<"organizations">;
          periodEnd: number;
          periodStart: number;
          subscriptionUnitsUsed: number;
        } | null
      >;
    };
  };
  bodyAccess: {
    issueToken: FunctionReference<
      "action",
      "public",
      { requestId: string },
      { expiresAt: number; token: string }
    >;
  };
  collectorCompatibilityPolicy: {
    getActivePolicy: FunctionReference<
      "query",
      "public",
      {},
      null | {
        denylistedVersions: Array<string>;
        minDesktopVersion: string;
        minParserVersion: string;
        updatedAt: number;
      }
    >;
    setPolicy: FunctionReference<
      "mutation",
      "public",
      {
        denylistedVersions: Array<string>;
        minDesktopVersion: string;
        minParserVersion: string;
      },
      Id<"collectorCompatibilityPolicy">
    >;
  };
  collectorCredentials: {
    list: FunctionReference<
      "query",
      "public",
      {},
      Array<{
        _creationTime: number;
        _id: Id<"collectorCredentials">;
        collectorId: string;
        expiresAt: number;
        lastSeenAt?: number;
        name?: string;
        orgId: Id<"organizations">;
        platform?: string;
        revokedAt?: number;
        status: "active" | "revoked";
        userId: Id<"users">;
      }>
    >;
    mint: FunctionReference<
      "mutation",
      "public",
      {
        collectorId: string;
        expiresAt: number;
        name?: string;
        platform?: string;
      },
      { id: Id<"collectorCredentials">; secret: string }
    >;
    revoke: FunctionReference<
      "mutation",
      "public",
      { id: Id<"collectorCredentials"> },
      null
    >;
  };
  costAlerts: {
    createAlert: FunctionReference<
      "mutation",
      "public",
      {
        apiKeyIds?: Array<Id<"apiKeys">>;
        channelIds: Array<Id<"costAlertChannels">>;
        condition:
          | {
              thresholdUsd: number;
              type: "absolute_spend_threshold";
              window: "last_hour" | "last_24_hours" | "month_to_date";
            }
          | { thresholdUsd: number; type: "projected_monthly_over" }
          | {
              baselineHours: number;
              minCurrentHourUsd: number;
              minIncreaseUsd: number;
              multiplier: number;
              type: "hourly_spend_spike";
            }
          | {
              approvedModels: Array<{
                allowZeroCost?: boolean;
                model: string;
                provider: string;
              }>;
              type: "model_approval_and_pricing";
              window: "last_hour" | "last_24_hours" | "month_to_date";
            };
        cooldownMinutes: number;
        name: string;
        notifyOnRecovery: boolean;
        severity: "info" | "warning" | "error";
        scope?: {
          baggageOperation?: string;
          baggageUserId?: string;
          model?: string;
          provider?: string;
        };
      },
      Id<"costAlerts">
    >;
    createChannel: FunctionReference<
      "mutation",
      "public",
      {
        config:
          | { recipients: Array<string>; type: "email" }
          | {
              headers?: Array<{ key: string; value: string }>;
              secret?: string;
              type: "webhook";
              url: string;
            };
        name: string;
      },
      Id<"costAlertChannels">
    >;
    listDeliveries: FunctionReference<
      "query",
      "public",
      {
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
      },
      any
    >;
    listForCurrentOrg: FunctionReference<
      "query",
      "public",
      {},
      {
        apiKeys: Array<{
          _creationTime: number;
          _id: Id<"apiKeys">;
          expiresAt: number;
          key: string;
          name?: string;
          orgId?: Id<"organizations">;
          userId?: Id<"users">;
        }>;
        channels: Array<{
          _creationTime: number;
          _id: Id<"costAlertChannels">;
          config:
            | { recipients: Array<string>; type: "email" }
            | {
                headers?: Array<{ key: string; value: string }>;
                secret?: string;
                type: "webhook";
                url: string;
              };
          createdAt: number;
          createdByUserId: Id<"users">;
          enabled: boolean;
          name: string;
          orgId: Id<"organizations">;
          updatedAt: number;
        }>;
        isOwner: boolean;
        rules: Array<{
          _creationTime: number;
          _id: Id<"costAlerts">;
          apiKeyIds?: Array<Id<"apiKeys">>;
          channelIds: Array<Id<"costAlertChannels">>;
          condition:
            | {
                thresholdUsd: number;
                type: "absolute_spend_threshold";
                window: "last_hour" | "last_24_hours" | "month_to_date";
              }
            | { thresholdUsd: number; type: "projected_monthly_over" }
            | {
                baselineHours: number;
                minCurrentHourUsd: number;
                minIncreaseUsd: number;
                multiplier: number;
                type: "hourly_spend_spike";
              }
            | {
                approvedModels: Array<{
                  allowZeroCost?: boolean;
                  model: string;
                  provider: string;
                }>;
                type: "model_approval_and_pricing";
                window: "last_hour" | "last_24_hours" | "month_to_date";
              };
          cooldownMinutes: number;
          createdAt: number;
          createdByUserId: Id<"users">;
          enabled: boolean;
          name: string;
          notifyOnRecovery: boolean;
          orgId: Id<"organizations">;
          severity: "info" | "warning" | "error";
          scope?: {
            baggageOperation?: string;
            baggageUserId?: string;
            model?: string;
            provider?: string;
          };
          updatedAt: number;
          updatedByUserId: Id<"users">;
        }>;
        states: Array<{
          _creationTime: number;
          _id: Id<"costAlertStates">;
          active: boolean;
          costAlertId: Id<"costAlerts">;
          lastDeliveryError?: string;
          lastEvaluatedAt: number;
          lastMetricLabel?: string;
          lastMetricValue?: number;
          lastNotificationAt?: number;
          lastRecoveredAt?: number;
          lastSummary?: string;
          lastTriggeredAt?: number;
          orgId: Id<"organizations">;
        }>;
      }
    >;
    removeAlert: FunctionReference<
      "mutation",
      "public",
      { id: Id<"costAlerts"> },
      null
    >;
    removeChannel: FunctionReference<
      "mutation",
      "public",
      { id: Id<"costAlertChannels"> },
      null
    >;
    testChannel: FunctionReference<
      "mutation",
      "public",
      { channelId: Id<"costAlertChannels"> },
      null
    >;
    toggleAlert: FunctionReference<
      "mutation",
      "public",
      { id: Id<"costAlerts"> },
      null
    >;
    toggleChannel: FunctionReference<
      "mutation",
      "public",
      { id: Id<"costAlertChannels"> },
      null
    >;
    updateAlert: FunctionReference<
      "mutation",
      "public",
      {
        apiKeyIds?: Array<Id<"apiKeys">>;
        channelIds?: Array<Id<"costAlertChannels">>;
        condition?:
          | {
              thresholdUsd: number;
              type: "absolute_spend_threshold";
              window: "last_hour" | "last_24_hours" | "month_to_date";
            }
          | { thresholdUsd: number; type: "projected_monthly_over" }
          | {
              baselineHours: number;
              minCurrentHourUsd: number;
              minIncreaseUsd: number;
              multiplier: number;
              type: "hourly_spend_spike";
            }
          | {
              approvedModels: Array<{
                allowZeroCost?: boolean;
                model: string;
                provider: string;
              }>;
              type: "model_approval_and_pricing";
              window: "last_hour" | "last_24_hours" | "month_to_date";
            };
        cooldownMinutes?: number;
        id: Id<"costAlerts">;
        name?: string;
        notifyOnRecovery?: boolean;
        severity?: "info" | "warning" | "error";
        scope?: {
          baggageOperation?: string;
          baggageUserId?: string;
          model?: string;
          provider?: string;
        };
      },
      null
    >;
    updateChannel: FunctionReference<
      "mutation",
      "public",
      {
        config?:
          | { recipients: Array<string>; type: "email" }
          | {
              headers?: Array<{ key: string; value: string }>;
              secret?: string;
              type: "webhook";
              url: string;
            };
        id: Id<"costAlertChannels">;
        name?: string;
      },
      null
    >;
  };
  feedback: {
    submit: FunctionReference<"mutation", "public", { message: string }, any>;
  };
  integrations: {
    cloudflare: {
      syncAll: FunctionReference<
        "action",
        "public",
        {},
        {
          collectorCredSynced: number;
          keySynced: number;
          subSynced: number;
          userOrgSynced: number;
        }
      >;
    };
    tinybird: {
      generateWebReadToken: FunctionReference<
        "action",
        "public",
        {},
        { expiresAt: number; name: string; token: string }
      >;
    };
  };
  waitlist: {
    bulkInviteFromWaitlist: FunctionReference<
      "mutation",
      "public",
      { waitlistIds: Array<Id<"waitlist">> },
      { invited: number }
    >;
    confirmEmail: FunctionReference<
      "mutation",
      "public",
      { token: string },
      { alreadyConfirmed: boolean }
    >;
    joinWaitlist: FunctionReference<
      "mutation",
      "public",
      { email: string; source?: string },
      | { confirmed: boolean; status: "already_on_waitlist" }
      | { id: Id<"waitlist">; status: "joined" }
    >;
    listWaitlist: FunctionReference<
      "query",
      "public",
      {},
      Array<{
        _creationTime: number;
        _id: Id<"waitlist">;
        confirmationToken: string;
        confirmed: boolean;
        email: string;
        notifiedAt?: number;
        source?: string;
      }>
    >;
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  admin: {
    admin: {
      deleteOrgDataScheduled: FunctionReference<
        "action",
        "internal",
        { orgId: Id<"organizations"> },
        {
          convexDeleted: {
            addonPurchases: number;
            alerts: number;
            apiKeys: number;
            invites: number;
            mcpRefreshTokens: number;
            mcpSessions: number;
            membersRemoved: number;
            usage: number;
          };
          stripeCanceled: boolean;
          tinybirdResults:
            | { deleted: false; reason: string }
            | {
                deleted: true;
                results: Record<string, { error?: string; success: boolean }>;
              };
        }
      >;
      deleteOrgRecordsBatch: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations"> },
        {
          counts: {
            addonPurchases: number;
            alerts: number;
            apiKeys: number;
            invites: number;
            mcpRefreshTokens: number;
            mcpSessions: number;
            membersRemoved: number;
            usage: number;
          };
          hasMore: boolean;
        }
      >;
      finalizeOrgDeletion: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations"> },
        null
      >;
      forceActivateSubscription: FunctionReference<
        "mutation",
        "internal",
        {
          monthlyUnits?: number;
          orgId: Id<"organizations">;
          periodDays?: number;
          tier?: "hobby" | "pro";
        },
        Id<"subscriptions">
      >;
    };
  };
  agentE2eSeed: {
    seedDevCollector: FunctionReference<
      "mutation",
      "internal",
      {},
      { collectorId: string; orgId: Id<"organizations">; userId: Id<"users"> }
    >;
  };
  agentSessionOwners: {
    claimSession: FunctionReference<
      "mutation",
      "internal",
      {
        collectorId: string;
        orgId: Id<"organizations">;
        sessionPk: string;
        userId: Id<"users">;
      },
      { ownerUserId: Id<"users">; status: "claimed" | "owned" | "conflict" }
    >;
    claimSessionsBatch: FunctionReference<
      "mutation",
      "internal",
      {
        collectorId: string;
        orgId: Id<"organizations">;
        sessionPks: Array<string>;
        userId: Id<"users">;
      },
      Array<{
        ownerUserId: Id<"users">;
        sessionPk: string;
        status: "claimed" | "owned" | "conflict";
      }>
    >;
  };
  analyst: {
    getOwnedThreadForAction: FunctionReference<
      "query",
      "internal",
      { threadId: Id<"analystThreads">; userId: Id<"users"> },
      any
    >;
    getThreadByAgentThreadIdForAction: FunctionReference<
      "query",
      "internal",
      { agentThreadId: string; userId: Id<"users"> },
      any
    >;
    getThreadStopRequestedAtForAction: FunctionReference<
      "query",
      "internal",
      { threadId: Id<"analystThreads">; userId: Id<"users"> },
      any
    >;
    insertThread: FunctionReference<
      "mutation",
      "internal",
      {
        agentThreadId: string;
        creatorUserId: Id<"users">;
        now: number;
        orgId: Id<"organizations">;
        title: string;
      },
      any
    >;
    recordAnalystUsageInternal: FunctionReference<
      "mutation",
      "internal",
      {
        agentThreadId: string;
        cacheReadTokens: number;
        cost?: number;
        now: number;
        totalTokens: number;
      },
      any
    >;
    requestThreadStop: FunctionReference<
      "mutation",
      "internal",
      { now: number; threadId: Id<"analystThreads">; userId: Id<"users"> },
      any
    >;
    streamMessage: FunctionReference<
      "action",
      "internal",
      {
        hiddenPrompt?: boolean;
        pageContextReferences?: Array<{
          filters?: Record<string, string | number | boolean | null>;
          label: string;
          objectId: string;
          route: string;
          surface: "agents";
        }>;
        prompt: string;
        stopBaselineAt?: number;
        threadId: Id<"analystThreads">;
        userId: Id<"users">;
      },
      any
    >;
    touchThread: FunctionReference<
      "mutation",
      "internal",
      { now: number; threadId: Id<"analystThreads">; userId: Id<"users"> },
      any
    >;
  };
  analystSandbox: {
    continueAfterSandboxRun: FunctionReference<
      "action",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    reapTimedOutSandboxRun: FunctionReference<
      "action",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    resumeOrFailStaleSandboxRun: FunctionReference<
      "action",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    timeoutSandboxRunIfExpired: FunctionReference<
      "mutation",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
  };
  analystSandboxStore: {
    appendSandboxRunEvents: FunctionReference<
      "mutation",
      "internal",
      {
        events: Array<{
          data?: any;
          emittedAt?: number;
          message?: string;
          type:
            | "status"
            | "stdout"
            | "stderr"
            | "message"
            | "tool_call"
            | "tool_result"
            | "result"
            | "error"
            | "control"
            | "usage";
        }>;
        now: number;
        runId: Id<"analystSandboxRuns">;
        tokenHash: string;
      },
      any
    >;
    completeSandboxRunInternal: FunctionReference<
      "mutation",
      "internal",
      {
        error?: string;
        now: number;
        resultText?: string;
        runId: Id<"analystSandboxRuns">;
        status: "completed" | "failed" | "timed_out" | "cancelled";
        tokenHash: string;
      },
      any
    >;
    createSandboxRun: FunctionReference<
      "mutation",
      "internal",
      {
        analystThreadId: Id<"analystThreads">;
        creatorUserId: Id<"users">;
        maxRuntimeMs: number;
        now: number;
        orgId: Id<"organizations">;
        pageContextReferences?: Array<{
          filters?: Record<string, string | number | boolean | null>;
          label: string;
          objectId: string;
          route: string;
          surface: "agents";
        }>;
        prompt: string;
        resumeAttempt?: number;
        runTokenHash: string;
        sandboxId: string;
      },
      any
    >;
    emitSandboxRunNote: FunctionReference<
      "mutation",
      "internal",
      {
        label: string;
        now: number;
        runId: Id<"analystSandboxRuns">;
        text: string;
      },
      any
    >;
    getActiveSandboxRunsForAction: FunctionReference<
      "query",
      "internal",
      { threadId: Id<"analystThreads">; userId: Id<"users"> },
      any
    >;
    getOwnedSandboxRunForAction: FunctionReference<
      "query",
      "internal",
      { runId: Id<"analystSandboxRuns">; userId: Id<"users"> },
      any
    >;
    getSandboxRunEventsForAction: FunctionReference<
      "query",
      "internal",
      { limit: number; runId: Id<"analystSandboxRuns">; userId: Id<"users"> },
      any
    >;
    getSandboxRunForAction: FunctionReference<
      "query",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    getSandboxRunForReap: FunctionReference<
      "query",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    getSandboxRunLivenessContext: FunctionReference<
      "query",
      "internal",
      { runId: Id<"analystSandboxRuns"> },
      any
    >;
    getVerifiedSandboxRunForAction: FunctionReference<
      "query",
      "internal",
      { runId: Id<"analystSandboxRuns">; tokenHash: string },
      any
    >;
    markSandboxContinuationScheduled: FunctionReference<
      "mutation",
      "internal",
      { now: number; runId: Id<"analystSandboxRuns"> },
      any
    >;
    markSandboxRunInterrupted: FunctionReference<
      "mutation",
      "internal",
      { error: string; now: number; runId: Id<"analystSandboxRuns"> },
      any
    >;
    markSandboxRunStarted: FunctionReference<
      "mutation",
      "internal",
      {
        now: number;
        processId?: string;
        runId: Id<"analystSandboxRuns">;
        userId: Id<"users">;
      },
      any
    >;
    markSandboxRunTimedOut: FunctionReference<
      "mutation",
      "internal",
      { error: string; now: number; runId: Id<"analystSandboxRuns"> },
      any
    >;
    recordSandboxControl: FunctionReference<
      "mutation",
      "internal",
      {
        action: "status" | "tail" | "cancel" | "steer" | "follow_up";
        message?: string;
        now: number;
        runId: Id<"analystSandboxRuns">;
        userId: Id<"users">;
      },
      any
    >;
    storeThreadSandboxBackup: FunctionReference<
      "mutation",
      "internal",
      {
        backup: { dir: string; id: string; localBucket?: boolean };
        now: number;
        runId: Id<"analystSandboxRuns">;
        tokenHash: string;
      },
      any
    >;
  };
  apiKeys: {
    getByIdInternal: FunctionReference<
      "query",
      "internal",
      { id: Id<"apiKeys"> },
      null | {
        _creationTime: number;
        _id: Id<"apiKeys">;
        expiresAt: number;
        key: string;
        name?: string;
        orgId?: Id<"organizations">;
        userId?: Id<"users">;
      }
    >;
    listByOrgId: FunctionReference<
      "query",
      "internal",
      { orgId: Id<"organizations"> },
      Array<{
        _creationTime: number;
        _id: Id<"apiKeys">;
        expiresAt: number;
        key: string;
        name?: string;
        orgId?: Id<"organizations">;
        userId?: Id<"users">;
      }>
    >;
    listByUserId: FunctionReference<
      "query",
      "internal",
      { userId: Id<"users"> },
      Array<{
        _creationTime: number;
        _id: Id<"apiKeys">;
        expiresAt: number;
        key: string;
        name?: string;
        orgId?: Id<"organizations">;
        userId?: Id<"users">;
      }>
    >;
    listForUser: FunctionReference<
      "query",
      "internal",
      { userId: Id<"users"> },
      Array<{
        _creationTime: number;
        _id: Id<"apiKeys">;
        expiresAt: number;
        key: string;
        name?: string;
        orgId?: Id<"organizations">;
        userId?: Id<"users">;
      }>
    >;
  };
  auth: {
    organizations: {
      getActiveMemberCountInternal: FunctionReference<
        "query",
        "internal",
        { orgId: Id<"organizations"> },
        number
      >;
      getByIdInternal: FunctionReference<
        "query",
        "internal",
        { id: Id<"organizations"> },
        null | {
          _creationTime: number;
          _id: Id<"organizations">;
          deletedAt?: number;
          name: string;
          onboardingCompletedAt?: number;
          ownerId: Id<"users">;
          stripeCustomerId?: string;
        }
      >;
      getByStripeCustomerId: FunctionReference<
        "query",
        "internal",
        { stripeCustomerId: string },
        null | {
          _creationTime: number;
          _id: Id<"organizations">;
          deletedAt?: number;
          name: string;
          onboardingCompletedAt?: number;
          ownerId: Id<"users">;
          stripeCustomerId?: string;
        }
      >;
      setStripeCustomerId: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations">; stripeCustomerId: string },
        null
      >;
    };
    users: {
      findOrCreateUser: FunctionReference<
        "mutation",
        "internal",
        {
          email: string;
          name?: string;
          picture?: string;
          tokenIdentifier: string;
        },
        Id<"users">
      >;
      getUserById: FunctionReference<
        "query",
        "internal",
        { id: Id<"users"> },
        {
          _creationTime: number;
          _id: Id<"users">;
          email: string;
          enabled: boolean;
          inviteId?: Id<"invites">;
          isAdmin?: boolean;
          name?: string;
          orgId?: Id<"organizations">;
          picture?: string;
          tokenIdentifier: string;
        } | null
      >;
      getUserByTokenIdentifier: FunctionReference<
        "query",
        "internal",
        { tokenIdentifier: string },
        {
          _creationTime: number;
          _id: Id<"users">;
          email: string;
          enabled: boolean;
          inviteId?: Id<"invites">;
          isAdmin?: boolean;
          name?: string;
          orgId?: Id<"organizations">;
          picture?: string;
          tokenIdentifier: string;
        } | null
      >;
      isAdminInternal: FunctionReference<"query", "internal", {}, boolean>;
    };
  };
  billing: {
    modelPricing: {
      getInternal: FunctionReference<
        "query",
        "internal",
        { model: string; provider: string },
        {
          _creationTime: number;
          _id: Id<"modelPricing">;
          cacheReadCostPerMillion?: number;
          cacheWrite1hCostPerMillion?: number;
          cacheWriteCostPerMillion?: number;
          completionCostPerMillion: number;
          contextTier?: {
            cacheReadCostPerMillion?: number;
            cacheWrite1hCostPerMillion?: number;
            cacheWriteCostPerMillion?: number;
            completionCostPerMillion: number;
            promptCostPerMillion: number;
            reasoningCostPerMillion?: number;
            thresholdTokens: number;
          };
          model: string;
          promptCostPerMillion: number;
          provider: string;
          reasoningCostPerMillion?: number;
          source: "manual" | "openrouter" | "default" | "models.dev";
          updatedAt: number;
        } | null
      >;
      importFromModelsDevInternal: FunctionReference<
        "action",
        "internal",
        {},
        { imported: number; skipped: number }
      >;
      importOneFromOpenRouterInternal: FunctionReference<
        "action",
        "internal",
        { model: string },
        { imported: boolean }
      >;
      listAll: FunctionReference<
        "query",
        "internal",
        any,
        Array<{
          _creationTime: number;
          _id: Id<"modelPricing">;
          cacheReadCostPerMillion?: number;
          cacheWrite1hCostPerMillion?: number;
          cacheWriteCostPerMillion?: number;
          completionCostPerMillion: number;
          contextTier?: {
            cacheReadCostPerMillion?: number;
            cacheWrite1hCostPerMillion?: number;
            cacheWriteCostPerMillion?: number;
            completionCostPerMillion: number;
            promptCostPerMillion: number;
            reasoningCostPerMillion?: number;
            thresholdTokens: number;
          };
          model: string;
          promptCostPerMillion: number;
          provider: string;
          reasoningCostPerMillion?: number;
          source: "manual" | "openrouter" | "default" | "models.dev";
          updatedAt: number;
        }>
      >;
      upsertInternal: FunctionReference<
        "mutation",
        "internal",
        {
          cacheReadCostPerMillion?: number;
          cacheWrite1hCostPerMillion?: number;
          cacheWriteCostPerMillion?: number;
          completionCostPerMillion: number;
          contextTier?: {
            cacheReadCostPerMillion?: number;
            cacheWrite1hCostPerMillion?: number;
            cacheWriteCostPerMillion?: number;
            completionCostPerMillion: number;
            promptCostPerMillion: number;
            reasoningCostPerMillion?: number;
            thresholdTokens: number;
          };
          model: string;
          promptCostPerMillion: number;
          provider: string;
          reasoningCostPerMillion?: number;
          source: "manual" | "openrouter" | "default" | "models.dev";
        },
        Id<"modelPricing">
      >;
    };
    pricingSync: {
      deleteFromKV: FunctionReference<
        "action",
        "internal",
        { model: string; provider: string },
        null
      >;
      syncToKV: FunctionReference<
        "action",
        "internal",
        { model: string; provider: string },
        null
      >;
    };
    stripeEvents: {
      cleanupOldEvents: FunctionReference<
        "mutation",
        "internal",
        {},
        { deleted: number }
      >;
      getByEventId: FunctionReference<
        "query",
        "internal",
        { eventId: string },
        {
          _creationTime: number;
          _id: Id<"stripeEvents">;
          error?: string;
          eventId: string;
          eventType: string;
          processedAt?: number;
          processingStartedAt?: number;
          status: "processing" | "processed" | "failed";
          stripeObjectId?: string;
        } | null
      >;
      markFailed: FunctionReference<
        "mutation",
        "internal",
        { error: string; eventId: string },
        null
      >;
      markProcessed: FunctionReference<
        "mutation",
        "internal",
        { eventId: string },
        null
      >;
      startProcessing: FunctionReference<
        "mutation",
        "internal",
        { eventId: string; eventType: string; stripeObjectId?: string },
        { alreadyProcessed: boolean; eventDocId: Id<"stripeEvents"> }
      >;
    };
    subscriptions: {
      addAddonUnits: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations">; units: number },
        null
      >;
      creditAddonPurchase: FunctionReference<
        "mutation",
        "internal",
        {
          amountCents: number;
          mode: "manual" | "auto";
          orgId: Id<"organizations">;
          stripeInvoiceId?: string;
          stripePaymentIntentId: string;
          triggeredByUserId?: Id<"users">;
          units: number;
        },
        null
      >;
      getByOrgId: FunctionReference<
        "query",
        "internal",
        { orgId: Id<"organizations"> },
        null | {
          _creationTime: number;
          _id: Id<"subscriptions">;
          addonPurchaseCount: number;
          addonUnits: number;
          autoOverage?: boolean;
          autoTopupPendingSince?: number;
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd: number;
          currentPeriodOverageSpentCents: number;
          currentPeriodStart: number;
          deletionSchedulerId?: Id<"_scheduled_functions">;
          gracePeriodSchedulerId?: Id<"_scheduled_functions">;
          monthlyUnits: number;
          orgId: Id<"organizations">;
          overageCapCents?: number;
          status: "active" | "grace" | "suspended" | "canceled";
          stripeCustomerId?: string;
          stripePlanItemId?: string;
          stripeSubscriptionId?: string;
          tier: "hobby" | "pro";
        }
      >;
      getByStripeCustomerId: FunctionReference<
        "query",
        "internal",
        { stripeCustomerId: string },
        null | {
          _creationTime: number;
          _id: Id<"subscriptions">;
          addonPurchaseCount: number;
          addonUnits: number;
          autoOverage?: boolean;
          autoTopupPendingSince?: number;
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd: number;
          currentPeriodOverageSpentCents: number;
          currentPeriodStart: number;
          deletionSchedulerId?: Id<"_scheduled_functions">;
          gracePeriodSchedulerId?: Id<"_scheduled_functions">;
          monthlyUnits: number;
          orgId: Id<"organizations">;
          overageCapCents?: number;
          status: "active" | "grace" | "suspended" | "canceled";
          stripeCustomerId?: string;
          stripePlanItemId?: string;
          stripeSubscriptionId?: string;
          tier: "hobby" | "pro";
        }
      >;
      getByStripeSubscriptionId: FunctionReference<
        "query",
        "internal",
        { stripeSubscriptionId: string },
        null | {
          _creationTime: number;
          _id: Id<"subscriptions">;
          addonPurchaseCount: number;
          addonUnits: number;
          autoOverage?: boolean;
          autoTopupPendingSince?: number;
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd: number;
          currentPeriodOverageSpentCents: number;
          currentPeriodStart: number;
          deletionSchedulerId?: Id<"_scheduled_functions">;
          gracePeriodSchedulerId?: Id<"_scheduled_functions">;
          monthlyUnits: number;
          orgId: Id<"organizations">;
          overageCapCents?: number;
          status: "active" | "grace" | "suspended" | "canceled";
          stripeCustomerId?: string;
          stripePlanItemId?: string;
          stripeSubscriptionId?: string;
          tier: "hobby" | "pro";
        }
      >;
      releaseAutoTopupReservation: FunctionReference<
        "mutation",
        "internal",
        { amountCents: number; orgId: Id<"organizations"> },
        null
      >;
      reserveAutoTopup: FunctionReference<
        "mutation",
        "internal",
        { amountCents: number; orgId: Id<"organizations"> },
        { idempotencyKey: string; ok: true } | { ok: false; reason: string }
      >;
      revertToHobby: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations"> },
        null
      >;
      revokeAddonPurchase: FunctionReference<
        "mutation",
        "internal",
        { stripePaymentIntentId: string },
        null
      >;
      scheduleGraceSuspension: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations"> },
        null
      >;
      setStripeCustomerId: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations">; stripeCustomerId: string },
        null
      >;
      setTier: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations">; tier: "hobby" | "pro" },
        null
      >;
      transitionGraceToSuspended: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"organizations"> },
        null
      >;
      triggerAutoTopup: FunctionReference<
        "action",
        "internal",
        {
          amountCents: number;
          orgId: Id<"organizations">;
          quantity?: number;
          reason?: string;
        },
        { ok: false; reason: string } | { invoiceId: string; ok: true }
      >;
      upsertStripeSubscriptionState: FunctionReference<
        "mutation",
        "internal",
        {
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd?: number;
          currentPeriodStart?: number;
          orgId: Id<"organizations">;
          status: "active" | "grace" | "suspended" | "canceled";
          stripeCustomerId?: string;
          stripePlanItemId?: string;
          stripeSubscriptionId?: string;
        },
        null
      >;
    };
    usage: {
      checkAutoTopup: FunctionReference<
        "mutation",
        "internal",
        {
          addonUnitsUsed: number;
          orgId: Id<"organizations">;
          subscriptionUnitsUsed: number;
        },
        null
      >;
      getForOrgInternal: FunctionReference<
        "query",
        "internal",
        { orgId: Id<"organizations"> },
        {
          _creationTime: number;
          _id: Id<"usage">;
          addonUnitsUsed: number;
          orgId: Id<"organizations">;
          periodEnd: number;
          periodStart: number;
          subscriptionUnitsUsed: number;
        } | null
      >;
      recordUsage: FunctionReference<
        "mutation",
        "internal",
        {
          addonUnitsUsed: number;
          orgId: Id<"organizations">;
          periodEnd: number;
          periodStart: number;
          subscriptionUnitsUsed: number;
        },
        null
      >;
    };
  };
  bodyAccess: {
    currentSubject: FunctionReference<
      "query",
      "internal",
      {},
      { orgId: Id<"organizations">; sub: string; userId: Id<"users"> }
    >;
  };
  collectorCompatibilityPolicy: {
    getActivePolicyInternal: FunctionReference<
      "query",
      "internal",
      {},
      null | {
        denylistedVersions: Array<string>;
        minDesktopVersion: string;
        minParserVersion: string;
        updatedAt: number;
      }
    >;
  };
  collectorCredentials: {
    getByIdInternal: FunctionReference<
      "query",
      "internal",
      { id: Id<"collectorCredentials"> },
      null | {
        _creationTime: number;
        _id: Id<"collectorCredentials">;
        collectorId: string;
        expiresAt: number;
        hashedSecret: string;
        lastSeenAt?: number;
        name?: string;
        orgId: Id<"organizations">;
        platform?: string;
        revokedAt?: number;
        status: "active" | "revoked";
        userId: Id<"users">;
      }
    >;
    listByOrgId: FunctionReference<
      "query",
      "internal",
      { orgId: Id<"organizations"> },
      Array<{
        _creationTime: number;
        _id: Id<"collectorCredentials">;
        collectorId: string;
        expiresAt: number;
        hashedSecret: string;
        lastSeenAt?: number;
        name?: string;
        orgId: Id<"organizations">;
        platform?: string;
        revokedAt?: number;
        status: "active" | "revoked";
        userId: Id<"users">;
      }>
    >;
  };
  collectorLogin: {
    mintForUser: FunctionReference<
      "mutation",
      "internal",
      {
        collectorId: string;
        expiresAt: number;
        name?: string;
        platform?: string;
        userId: Id<"users">;
      },
      {
        id: Id<"collectorCredentials">;
        orgId: Id<"organizations">;
        secret: string;
      }
    >;
    resolveLoginOrg: FunctionReference<
      "query",
      "internal",
      { userId: Id<"users"> },
      null | { orgId: Id<"organizations">; orgName: string }
    >;
  };
  costAlerts: {
    cleanupDeliveries: FunctionReference<
      "mutation",
      "internal",
      { costAlertId: Id<"costAlerts"> },
      null
    >;
    getRuntimeContext: FunctionReference<
      "query",
      "internal",
      { orgId: Id<"organizations"> },
      {
        alerts: Array<{
          _creationTime: number;
          _id: Id<"costAlerts">;
          apiKeyIds?: Array<Id<"apiKeys">>;
          channelIds: Array<Id<"costAlertChannels">>;
          condition:
            | {
                thresholdUsd: number;
                type: "absolute_spend_threshold";
                window: "last_hour" | "last_24_hours" | "month_to_date";
              }
            | { thresholdUsd: number; type: "projected_monthly_over" }
            | {
                baselineHours: number;
                minCurrentHourUsd: number;
                minIncreaseUsd: number;
                multiplier: number;
                type: "hourly_spend_spike";
              }
            | {
                approvedModels: Array<{
                  allowZeroCost?: boolean;
                  model: string;
                  provider: string;
                }>;
                type: "model_approval_and_pricing";
                window: "last_hour" | "last_24_hours" | "month_to_date";
              };
          cooldownMinutes: number;
          createdAt: number;
          createdByUserId: Id<"users">;
          enabled: boolean;
          name: string;
          notifyOnRecovery: boolean;
          orgId: Id<"organizations">;
          severity: "info" | "warning" | "error";
          scope?: {
            baggageOperation?: string;
            baggageUserId?: string;
            model?: string;
            provider?: string;
          };
          updatedAt: number;
          updatedByUserId: Id<"users">;
        }>;
        apiKeys: Array<{
          _creationTime: number;
          _id: Id<"apiKeys">;
          expiresAt: number;
          key: string;
          name?: string;
          orgId?: Id<"organizations">;
          userId?: Id<"users">;
        }>;
        channels: Array<{
          _creationTime: number;
          _id: Id<"costAlertChannels">;
          config:
            | { recipients: Array<string>; type: "email" }
            | {
                headers?: Array<{ key: string; value: string }>;
                secret?: string;
                type: "webhook";
                url: string;
              };
          createdAt: number;
          createdByUserId: Id<"users">;
          enabled: boolean;
          name: string;
          orgId: Id<"organizations">;
          updatedAt: number;
        }>;
        org: {
          _creationTime: number;
          _id: Id<"organizations">;
          deletedAt?: number;
          name: string;
          onboardingCompletedAt?: number;
          ownerId: Id<"users">;
          stripeCustomerId?: string;
        } | null;
        states: Array<{
          _creationTime: number;
          _id: Id<"costAlertStates">;
          active: boolean;
          costAlertId: Id<"costAlerts">;
          lastDeliveryError?: string;
          lastEvaluatedAt: number;
          lastMetricLabel?: string;
          lastMetricValue?: number;
          lastNotificationAt?: number;
          lastRecoveredAt?: number;
          lastSummary?: string;
          lastTriggeredAt?: number;
          orgId: Id<"organizations">;
        }>;
      }
    >;
    recordDelivery: FunctionReference<
      "mutation",
      "internal",
      {
        attemptedAt: number;
        channelId: Id<"costAlertChannels">;
        costAlertId?: Id<"costAlerts">;
        deliveredAt?: number;
        error?: string;
        eventType: "triggered" | "recovered" | "test";
        idempotencyKey: string;
        orgId: Id<"organizations">;
        payloadSummary: string;
        status: "success" | "failed";
      },
      Id<"costAlertDeliveries">
    >;
    recordState: FunctionReference<
      "mutation",
      "internal",
      {
        active: boolean;
        costAlertId: Id<"costAlerts">;
        lastDeliveryError?: string;
        lastEvaluatedAt: number;
        lastMetricLabel?: string;
        lastMetricValue?: number;
        lastNotificationAt?: number;
        lastRecoveredAt?: number;
        lastSummary?: string;
        lastTriggeredAt?: number;
        orgId: Id<"organizations">;
      },
      Id<"costAlertStates">
    >;
    recoverStaleMonitors: FunctionReference<"mutation", "internal", {}, null>;
    syncMonitor: FunctionReference<
      "mutation",
      "internal",
      {
        delayMs: number | null;
        lastError?: string;
        lastEvaluatedAt?: number;
        orgId: Id<"organizations">;
      },
      null
    >;
  };
  integrations: {
    cloudflare: {
      checkKeyInKV: FunctionReference<
        "action",
        "internal",
        { key: string },
        boolean
      >;
      deleteCollectorCredFromKV: FunctionReference<
        "action",
        "internal",
        { hashedSecret: string; retryCount?: number },
        null
      >;
      deleteKeyFromKV: FunctionReference<
        "action",
        "internal",
        { key: string; retryCount?: number },
        null
      >;
      deleteUserOrgFromKV: FunctionReference<
        "action",
        "internal",
        { retryCount?: number; sub: string },
        null
      >;
      getAllSyncData: FunctionReference<
        "query",
        "internal",
        {},
        {
          apiKeys: Array<{
            _creationTime: number;
            _id: Id<"apiKeys">;
            expiresAt: number;
            key: string;
            name?: string;
            orgId?: Id<"organizations">;
            userId?: Id<"users">;
          }>;
          collectorCredentials: Array<{
            _creationTime: number;
            _id: Id<"collectorCredentials">;
            collectorId: string;
            expiresAt: number;
            hashedSecret: string;
            lastSeenAt?: number;
            name?: string;
            orgId: Id<"organizations">;
            platform?: string;
            revokedAt?: number;
            status: "active" | "revoked";
            userId: Id<"users">;
          }>;
          subscriptions: Array<{
            _creationTime: number;
            _id: Id<"subscriptions">;
            addonPurchaseCount: number;
            addonUnits: number;
            autoOverage?: boolean;
            autoTopupPendingSince?: number;
            cancelAtPeriodEnd?: boolean;
            currentPeriodEnd: number;
            currentPeriodOverageSpentCents: number;
            currentPeriodStart: number;
            deletionSchedulerId?: Id<"_scheduled_functions">;
            gracePeriodSchedulerId?: Id<"_scheduled_functions">;
            monthlyUnits: number;
            orgId: Id<"organizations">;
            overageCapCents?: number;
            status: "active" | "grace" | "suspended" | "canceled";
            stripeCustomerId?: string;
            stripePlanItemId?: string;
            stripeSubscriptionId?: string;
            tier: "hobby" | "pro";
          }>;
          users: Array<{
            _creationTime: number;
            _id: Id<"users">;
            email: string;
            enabled: boolean;
            inviteId?: Id<"invites">;
            isAdmin?: boolean;
            name?: string;
            orgId?: Id<"organizations">;
            picture?: string;
            tokenIdentifier: string;
          }>;
        }
      >;
      isCallerAdmin: FunctionReference<"query", "internal", {}, boolean>;
      syncCollectorCredToKV: FunctionReference<
        "action",
        "internal",
        {
          collectorId: string;
          createdAt: number;
          expiresAt: number;
          hashedSecret: string;
          orgId: string;
          retryCount?: number;
          status: "active" | "revoked";
          userId: string;
        },
        null
      >;
      syncKeyToKV: FunctionReference<
        "action",
        "internal",
        { expiresAt: number; key: string; orgId?: string },
        null
      >;
      syncSubscriptionToKV: FunctionReference<
        "action",
        "internal",
        {
          addonUnits: number;
          autoOverage?: boolean;
          cancelAtPeriodEnd?: boolean;
          currentPeriodEnd: number;
          currentPeriodStart: number;
          monthlyUnits: number;
          orgId: string;
          overageCapCents?: number;
          retryCount?: number;
          status: string;
          tier: string;
        },
        null
      >;
      syncUserOrgToKV: FunctionReference<
        "action",
        "internal",
        { orgId: string; retryCount?: number; sub: string },
        null
      >;
    };
    costAlerts: {
      evaluateOrg: FunctionReference<
        "action",
        "internal",
        { orgId: Id<"organizations"> },
        null
      >;
      sendTestChannel: FunctionReference<
        "action",
        "internal",
        { channelId: Id<"costAlertChannels">; orgId: Id<"organizations"> },
        null
      >;
    };
    emails: {
      sendConfirmationEmail: FunctionReference<
        "action",
        "internal",
        { confirmationToken: string; email: string },
        null
      >;
      sendInviteEmail: FunctionReference<
        "action",
        "internal",
        { email: string; token: string },
        null
      >;
    };
    tinybird: {
      deleteOrgTraces: FunctionReference<
        "action",
        "internal",
        { orgId: Id<"organizations"> },
        | { deleted: false; reason: string }
        | {
            deleted: true;
            results: Record<string, { error?: string; success: boolean }>;
          }
      >;
      extendRetention: FunctionReference<
        "action",
        "internal",
        { orgId: Id<"organizations"> },
        | { reason: string; updated: false }
        | {
            results: Record<string, { error?: string; success: boolean }>;
            updated: true;
          }
      >;
      generateTokenInternal: FunctionReference<
        "action",
        "internal",
        {
          apiKeys: Array<string>;
          orgId?: string;
          retentionDays?: number;
          scopes: Array<{ resource: string; type: string }>;
          ttl?: number;
        },
        string
      >;
    };
  };
  mcp: {
    clients: {
      getClient: FunctionReference<
        "query",
        "internal",
        { clientId: string },
        any
      >;
      registerClient: FunctionReference<
        "mutation",
        "internal",
        { clientId: string; clientName?: string; redirectUris: Array<string> },
        any
      >;
    };
    tokens: {
      cleanupAuthCode: FunctionReference<
        "mutation",
        "internal",
        { code: string },
        null
      >;
      cleanupRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { hashedTokenId: string },
        null
      >;
      createAuthCode: FunctionReference<
        "mutation",
        "internal",
        {
          auth0RefreshToken: string;
          clientId: string;
          codeChallenge: string;
          codeChallengeMethod: "S256";
          redirectUri: string;
          resource: string;
          userId: Id<"users">;
        },
        string
      >;
      createRefreshToken: FunctionReference<
        "mutation",
        "internal",
        {
          auth0RefreshToken: string;
          clientId: string;
          resource: string;
          userId: Id<"users">;
        },
        string
      >;
      deleteRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { tokenId: string },
        null
      >;
      deleteUserRefreshTokens: FunctionReference<
        "mutation",
        "internal",
        { userId: Id<"users"> },
        null
      >;
      exchangeAuthCode: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          code: string;
          codeVerifier: string;
          redirectUri: string;
          resource: string;
        },
        | { error: string; error_description: string }
        | { resource: string; tokenId: string; userId: Id<"users"> }
      >;
      getRefreshToken: FunctionReference<
        "query",
        "internal",
        { tokenId: string },
        {
          _creationTime: number;
          _id: Id<"mcpRefreshTokens">;
          auth0RefreshToken: string;
          clientId?: string;
          expiresAt: number;
          hashedTokenId: string;
          resource?: string;
          tokenId?: string;
          userId: Id<"users">;
        } | null
      >;
      rotateRefreshToken: FunctionReference<
        "mutation",
        "internal",
        {
          auth0RefreshToken: string;
          clientId: string;
          resource: string;
          tokenId: string;
        },
        | { error: string; error_description: string }
        | { resource: string; tokenId: string; userId: Id<"users"> }
      >;
      updateRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { auth0RefreshToken: string; tokenId: string },
        null
      >;
    };
  };
  migrations: {
    advanceBillingPeriod: FunctionReference<
      "mutation",
      "internal",
      { orgId: Id<"organizations"> },
      any
    >;
    backfillAll: FunctionReference<"mutation", "internal", {}, any>;
    backfillHashedTokenIds: FunctionReference<"mutation", "internal", {}, any>;
    backfillOrgBilling: {
      backfillOrgBilling: FunctionReference<"mutation", "internal", any, any>;
    };
    backfillOrgs: {
      backfillOrgs: FunctionReference<"mutation", "internal", any, any>;
    };
    backfillStripeCustomerIdToOrgs: {
      backfillStripeCustomerIdToOrgs: FunctionReference<
        "mutation",
        "internal",
        any,
        any
      >;
    };
  };
};

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  launchdarkly: import("@convex-dev/launchdarkly/_generated/component.js").ComponentApi<"launchdarkly">;
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
