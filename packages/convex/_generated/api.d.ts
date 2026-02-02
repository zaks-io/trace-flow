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
  apiKeys: {
    create: FunctionReference<
      "mutation",
      "public",
      { expiresAt: number; name?: string },
      any
    >;
    getByKey: FunctionReference<"query", "public", { key: string }, any>;
    list: FunctionReference<"query", "public", any, any>;
    remove: FunctionReference<"mutation", "public", { id: Id<"apiKeys"> }, any>;
    syncToKV: FunctionReference<"action", "public", { id: Id<"apiKeys"> }, any>;
    update: FunctionReference<
      "mutation",
      "public",
      { id: Id<"apiKeys">; name?: string },
      any
    >;
  };
  auth: {
    hasTraceFlowRole: FunctionReference<"query", "public", any, any>;
  };
  cloudflare: {
    syncAll: FunctionReference<"action", "public", {}, any>;
  };
  mcp: {
    handler: {
      handleMessage: FunctionReference<
        "action",
        "public",
        { message: any; sessionId?: string },
        any
      >;
      handleMessageWithUser: FunctionReference<
        "action",
        "public",
        { message: any; sessionId?: string; userId: Id<"users"> },
        any
      >;
      terminateSession: FunctionReference<
        "action",
        "public",
        { sessionId: string },
        any
      >;
    };
    session: {
      getSession: FunctionReference<
        "query",
        "public",
        { sessionId: string },
        any
      >;
      getUserSessions: FunctionReference<
        "query",
        "public",
        { userId: Id<"users"> },
        any
      >;
    };
  };
  modelPricing: {
    get: FunctionReference<
      "query",
      "public",
      { model: string; provider: string },
      any
    >;
    importFromOpenRouter: FunctionReference<"action", "public", {}, any>;
    list: FunctionReference<"query", "public", { provider?: string }, any>;
    remove: FunctionReference<
      "mutation",
      "public",
      { id: Id<"modelPricing"> },
      any
    >;
    syncAllToKV: FunctionReference<"action", "public", {}, any>;
    syncDefaults: FunctionReference<"action", "public", {}, any>;
    upsert: FunctionReference<
      "mutation",
      "public",
      {
        cacheReadCostPerMillion?: number;
        cacheWriteCostPerMillion?: number;
        completionCostPerMillion: number;
        model: string;
        promptCostPerMillion: number;
        provider: string;
        reasoningCostPerMillion?: number;
        source: "manual" | "openrouter" | "default";
      },
      any
    >;
  };
  organizations: {
    get: FunctionReference<"query", "public", any, any>;
    rename: FunctionReference<"mutation", "public", { name: string }, any>;
  };
  subscriptions: {
    addAddonUnits: FunctionReference<
      "mutation",
      "public",
      { orgId: Id<"organizations">; units: number },
      any
    >;
    getForCurrentUser: FunctionReference<"query", "public", any, any>;
    setTier: FunctionReference<
      "mutation",
      "public",
      { orgId: Id<"organizations">; tier: "hobby" | "pro" },
      any
    >;
  };
  tinybird: {
    generateToken: FunctionReference<
      "action",
      "public",
      {
        name?: string;
        scopes: Array<{
          fixed_params?: Record<string, any>;
          resource: string;
          type: string;
        }>;
        ttl?: number;
      },
      any
    >;
  };
  usage: {
    getCurrentUsage: FunctionReference<"query", "public", any, any>;
  };
  users: {
    getCurrentUserQuery: FunctionReference<"query", "public", {}, any>;
    getUser: FunctionReference<"query", "public", { id: Id<"users"> }, any>;
    initializeUser: FunctionReference<"mutation", "public", {}, any>;
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
  apiKeys: {
    getByIdInternal: FunctionReference<
      "query",
      "internal",
      { id: Id<"apiKeys"> },
      any
    >;
    listByUserId: FunctionReference<
      "query",
      "internal",
      { userId: Id<"users"> },
      any
    >;
  };
  cloudflare: {
    checkKeyInKV: FunctionReference<"action", "internal", { key: string }, any>;
    deleteKeyFromKV: FunctionReference<
      "action",
      "internal",
      { key: string },
      any
    >;
    getAllSyncData: FunctionReference<"query", "internal", {}, any>;
    syncKeyToKV: FunctionReference<
      "action",
      "internal",
      { expiresAt: number; key: string; orgId?: string },
      any
    >;
    syncSubscriptionToKV: FunctionReference<
      "action",
      "internal",
      { addonUnits: number; monthlyUnits: number; orgId: string; tier: string },
      any
    >;
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
    session: {
      cleanupSession: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string },
        any
      >;
      createSession: FunctionReference<
        "mutation",
        "internal",
        { protocolVersion: string; userId: Id<"users"> },
        any
      >;
      deleteSession: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string },
        any
      >;
      getSessionInternal: FunctionReference<
        "query",
        "internal",
        { sessionId: string },
        any
      >;
      updateSessionState: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string; state: "initializing" | "ready" | "shutdown" },
        any
      >;
    };
    tokens: {
      cleanupAuthCode: FunctionReference<
        "mutation",
        "internal",
        { code: string },
        any
      >;
      cleanupRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { tokenId: string },
        any
      >;
      createAuthCode: FunctionReference<
        "mutation",
        "internal",
        {
          auth0RefreshToken: string;
          clientId?: string;
          codeChallenge?: string;
          codeChallengeMethod?: string;
          redirectUri: string;
          userId: Id<"users">;
        },
        any
      >;
      createRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { auth0RefreshToken: string; userId: Id<"users"> },
        any
      >;
      deleteRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { tokenId: string },
        any
      >;
      deleteUserRefreshTokens: FunctionReference<
        "mutation",
        "internal",
        { userId: Id<"users"> },
        any
      >;
      exchangeAuthCode: FunctionReference<
        "mutation",
        "internal",
        { code: string; codeVerifier?: string; redirectUri: string },
        any
      >;
      getRefreshToken: FunctionReference<
        "query",
        "internal",
        { tokenId: string },
        any
      >;
      updateRefreshToken: FunctionReference<
        "mutation",
        "internal",
        { auth0RefreshToken: string; tokenId: string },
        any
      >;
    };
    tools: {
      getTrace: FunctionReference<
        "action",
        "internal",
        { apiKeys: Array<string>; params: { trace_id: string } },
        any
      >;
      getTraceAction: {
        getTrace: FunctionReference<
          "action",
          "internal",
          { apiKeys: Array<string>; params: { trace_id: string } },
          any
        >;
      };
      getTraceEvents: FunctionReference<
        "action",
        "internal",
        {
          apiKeys: Array<string>;
          params: {
            cursor?: string;
            event_names?: Array<string>;
            limit?: number;
            order?: string;
            span_id?: string;
            span_names?: Array<string>;
            trace_id: string;
          };
        },
        any
      >;
      getTraceEventsAction: {
        getTraceEvents: FunctionReference<
          "action",
          "internal",
          {
            apiKeys: Array<string>;
            params: {
              cursor?: string;
              event_names?: Array<string>;
              limit?: number;
              order?: string;
              span_id?: string;
              span_names?: Array<string>;
              trace_id: string;
            };
          },
          any
        >;
      };
      getTraceSpans: FunctionReference<
        "action",
        "internal",
        {
          apiKeys: Array<string>;
          params: {
            cursor?: string;
            exclude_span_names?: Array<string>;
            expand?: Array<string>;
            limit?: number;
            min_duration_ms?: number;
            order?: string;
            sort_by?: string;
            span_names?: Array<string>;
            top_n?: number;
            trace_id: string;
          };
        },
        any
      >;
      getTraceSpansAction: {
        getTraceSpans: FunctionReference<
          "action",
          "internal",
          {
            apiKeys: Array<string>;
            params: {
              cursor?: string;
              exclude_span_names?: Array<string>;
              expand?: Array<string>;
              limit?: number;
              min_duration_ms?: number;
              order?: string;
              sort_by?: string;
              span_names?: Array<string>;
              top_n?: number;
              trace_id: string;
            };
          },
          any
        >;
      };
      index: {
        getTrace: FunctionReference<
          "action",
          "internal",
          { apiKeys: Array<string>; params: { trace_id: string } },
          any
        >;
        getTraceEvents: FunctionReference<
          "action",
          "internal",
          {
            apiKeys: Array<string>;
            params: {
              cursor?: string;
              event_names?: Array<string>;
              limit?: number;
              order?: string;
              span_id?: string;
              span_names?: Array<string>;
              trace_id: string;
            };
          },
          any
        >;
        getTraceSpans: FunctionReference<
          "action",
          "internal",
          {
            apiKeys: Array<string>;
            params: {
              cursor?: string;
              exclude_span_names?: Array<string>;
              expand?: Array<string>;
              limit?: number;
              min_duration_ms?: number;
              order?: string;
              sort_by?: string;
              span_names?: Array<string>;
              top_n?: number;
              trace_id: string;
            };
          },
          any
        >;
        listTraces: FunctionReference<
          "action",
          "internal",
          {
            apiKeys: Array<string>;
            params: {
              cursor?: string;
              hours?: number;
              limit?: number;
              model?: string;
              order?: string;
              provider?: string;
              sort_by?: string;
              status?: string;
            };
          },
          any
        >;
      };
      listTraces: FunctionReference<
        "action",
        "internal",
        {
          apiKeys: Array<string>;
          params: {
            cursor?: string;
            hours?: number;
            limit?: number;
            model?: string;
            order?: string;
            provider?: string;
            sort_by?: string;
            status?: string;
          };
        },
        any
      >;
      listTracesAction: {
        listTraces: FunctionReference<
          "action",
          "internal",
          {
            apiKeys: Array<string>;
            params: {
              cursor?: string;
              hours?: number;
              limit?: number;
              model?: string;
              order?: string;
              provider?: string;
              sort_by?: string;
              status?: string;
            };
          },
          any
        >;
      };
    };
  };
  migrations: {
    backfillOrgs: {
      backfillOrgs: FunctionReference<"mutation", "internal", any, any>;
    };
  };
  modelPricing: {
    getInternal: FunctionReference<
      "query",
      "internal",
      { model: string; provider: string },
      any
    >;
    listAll: FunctionReference<"query", "internal", any, any>;
    upsertInternal: FunctionReference<
      "mutation",
      "internal",
      {
        cacheReadCostPerMillion?: number;
        cacheWriteCostPerMillion?: number;
        completionCostPerMillion: number;
        model: string;
        promptCostPerMillion: number;
        provider: string;
        reasoningCostPerMillion?: number;
        source: "manual" | "openrouter" | "default";
      },
      any
    >;
  };
  organizations: {
    getByIdInternal: FunctionReference<
      "query",
      "internal",
      { id: Id<"organizations"> },
      any
    >;
  };
  pricingSync: {
    deleteFromKV: FunctionReference<
      "action",
      "internal",
      { model: string; provider: string },
      any
    >;
    syncToKV: FunctionReference<
      "action",
      "internal",
      { model: string; provider: string },
      any
    >;
  };
  subscriptions: {
    getByOrgId: FunctionReference<
      "query",
      "internal",
      { orgId: Id<"organizations"> },
      any
    >;
  };
  tinybird: {
    generateTokenInternal: FunctionReference<
      "action",
      "internal",
      {
        apiKeys: Array<string>;
        scopes: Array<{ resource: string; type: string }>;
        ttl?: number;
      },
      any
    >;
  };
  usage: {
    getForOrgInternal: FunctionReference<
      "query",
      "internal",
      { orgId: Id<"organizations"> },
      any
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
      any
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
      any
    >;
    getUserById: FunctionReference<
      "query",
      "internal",
      { id: Id<"users"> },
      any
    >;
  };
};

export declare const components: {};
