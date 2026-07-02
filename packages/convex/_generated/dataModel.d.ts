/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
  AnyDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";

/**
 * A type describing your Convex data model.
 *
 * This type includes information about what tables you have, the type of
 * documents stored in those tables, and the indexes defined on them.
 *
 * This type is used to parameterize methods like `queryGeneric` and
 * `mutationGeneric` to make them type-safe.
 */

export type DataModel = {
  addonPurchases: {
    document: {
      amountCents: number;
      mode: "manual" | "auto";
      orgId: Id<"organizations">;
      periodStart: number;
      stripeInvoiceId?: string;
      stripePaymentIntentId: string;
      triggeredByUserId?: Id<"users">;
      units: number;
      _id: Id<"addonPurchases">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "amountCents"
      | "mode"
      | "orgId"
      | "periodStart"
      | "stripeInvoiceId"
      | "stripePaymentIntentId"
      | "triggeredByUserId"
      | "units";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_payment_intent: ["stripePaymentIntentId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  agentSessionOwners: {
    document: {
      claimedAt: number;
      collectorId: string;
      orgId: Id<"organizations">;
      sessionPk: string;
      userId: Id<"users">;
      _id: Id<"agentSessionOwners">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "claimedAt"
      | "collectorId"
      | "orgId"
      | "sessionPk"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_session: ["orgId", "sessionPk", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  alerts: {
    document: {
      createdAt: number;
      enabled: boolean;
      field: string;
      name: string;
      operator: string;
      severity: string;
      updatedAt: number;
      userId: Id<"users">;
      value: number | string | boolean;
      _id: Id<"alerts">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "enabled"
      | "field"
      | "name"
      | "operator"
      | "severity"
      | "updatedAt"
      | "userId"
      | "value";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_user_id: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  analystSandboxRunEvents: {
    document: {
      analystThreadId: Id<"analystThreads">;
      creatorUserId: Id<"users">;
      data?: any;
      emittedAt: number;
      message?: string;
      orgId: Id<"organizations">;
      runId: Id<"analystSandboxRuns">;
      seq: number;
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
      _id: Id<"analystSandboxRunEvents">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "analystThreadId"
      | "creatorUserId"
      | "data"
      | "emittedAt"
      | "message"
      | "orgId"
      | "runId"
      | "seq"
      | "type";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_run_seq: ["runId", "seq", "_creationTime"];
      by_thread_seq: ["analystThreadId", "seq", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  analystSandboxRuns: {
    document: {
      analystThreadId: Id<"analystThreads">;
      completedAt?: number;
      continuationScheduledAt?: number;
      creatorUserId: Id<"users">;
      error?: string;
      lastEventAt?: number;
      maxRuntimeMs: number;
      nextSeq: number;
      orgId: Id<"organizations">;
      pageContextReferences?: Array<any>;
      processId?: string;
      prompt: string;
      resultText?: string;
      resumeAttempt?: number;
      runTokenHash: string;
      sandboxId: string;
      startedAt?: number;
      status:
        | "queued"
        | "starting"
        | "running"
        | "completed"
        | "failed"
        | "timed_out"
        | "cancelled";
      updatedAt: number;
      usageApplied?: {
        cacheReadTokens: number;
        totalCost: number;
        totalTokens: number;
      };
      _id: Id<"analystSandboxRuns">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "analystThreadId"
      | "completedAt"
      | "continuationScheduledAt"
      | "creatorUserId"
      | "error"
      | "lastEventAt"
      | "maxRuntimeMs"
      | "nextSeq"
      | "orgId"
      | "pageContextReferences"
      | "processId"
      | "prompt"
      | "resultText"
      | "resumeAttempt"
      | "runTokenHash"
      | "sandboxId"
      | "startedAt"
      | "status"
      | "updatedAt"
      | "usageApplied"
      | "usageApplied.cacheReadTokens"
      | "usageApplied.totalCost"
      | "usageApplied.totalTokens";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_creator_status_updated: [
        "creatorUserId",
        "status",
        "updatedAt",
        "_creationTime",
      ];
      by_status_updated: ["status", "updatedAt", "_creationTime"];
      by_thread_updated: ["analystThreadId", "updatedAt", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  analystThreads: {
    document: {
      agentThreadId: string;
      creatorUserId: Id<"users">;
      lastMessageAt?: number;
      orgId: Id<"organizations">;
      sandboxBackup?: {
        dir: string;
        id: string;
        localBucket?: boolean;
        updatedAt: number;
      };
      status: "active" | "archived";
      stopRequestedAt?: number;
      title: string;
      updatedAt: number;
      _id: Id<"analystThreads">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "agentThreadId"
      | "creatorUserId"
      | "lastMessageAt"
      | "orgId"
      | "sandboxBackup"
      | "sandboxBackup.dir"
      | "sandboxBackup.id"
      | "sandboxBackup.localBucket"
      | "sandboxBackup.updatedAt"
      | "status"
      | "stopRequestedAt"
      | "title"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_agent_thread_id: ["agentThreadId", "_creationTime"];
      by_creator_status_updated: [
        "creatorUserId",
        "status",
        "updatedAt",
        "_creationTime",
      ];
      by_creator_updated: ["creatorUserId", "updatedAt", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  analystUsageLedger: {
    document: {
      agent: "analyst" | "pi";
      analystThreadId: Id<"analystThreads">;
      cacheReadTokens: number;
      creatorUserId: Id<"users">;
      hasCost: boolean;
      orgId: Id<"organizations">;
      requests: number;
      totalCost: number;
      totalTokens: number;
      updatedAt: number;
      _id: Id<"analystUsageLedger">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "agent"
      | "analystThreadId"
      | "cacheReadTokens"
      | "creatorUserId"
      | "hasCost"
      | "orgId"
      | "requests"
      | "totalCost"
      | "totalTokens"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org: ["orgId", "_creationTime"];
      by_thread: ["analystThreadId", "_creationTime"];
      by_thread_agent: ["analystThreadId", "agent", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  apiKeys: {
    document: {
      expiresAt: number;
      key: string;
      name?: string;
      orgId?: Id<"organizations">;
      userId?: Id<"users">;
      _id: Id<"apiKeys">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "expiresAt"
      | "key"
      | "name"
      | "orgId"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_user_id: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  collectorCompatibilityPolicy: {
    document: {
      denylistedVersions: Array<string>;
      minDesktopVersion: string;
      minParserVersion: string;
      updatedAt: number;
      updatedByUserId?: Id<"users">;
      _id: Id<"collectorCompatibilityPolicy">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "denylistedVersions"
      | "minDesktopVersion"
      | "minParserVersion"
      | "updatedAt"
      | "updatedByUserId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_updated_at: ["updatedAt", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  collectorCredentials: {
    document: {
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
      _id: Id<"collectorCredentials">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "collectorId"
      | "expiresAt"
      | "hashedSecret"
      | "lastSeenAt"
      | "name"
      | "orgId"
      | "platform"
      | "revokedAt"
      | "status"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_hashed_secret: ["hashedSecret", "_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_user_id: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  costAlertChannels: {
    document: {
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
      _id: Id<"costAlertChannels">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "config"
      | "config.headers"
      | "config.recipients"
      | "config.secret"
      | "config.type"
      | "config.url"
      | "createdAt"
      | "createdByUserId"
      | "enabled"
      | "name"
      | "orgId"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  costAlertDeliveries: {
    document: {
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
      _id: Id<"costAlertDeliveries">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "attemptedAt"
      | "channelId"
      | "costAlertId"
      | "deliveredAt"
      | "error"
      | "eventType"
      | "idempotencyKey"
      | "orgId"
      | "payloadSummary"
      | "status";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_alert_id: ["costAlertId", "_creationTime"];
      by_channel_id: ["channelId", "_creationTime"];
      by_idempotency_key: ["idempotencyKey", "_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_org_id_attempted_at: ["orgId", "attemptedAt", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  costAlertMonitors: {
    document: {
      lastError?: string;
      lastEvaluatedAt?: number;
      nextEvaluationAt?: number;
      orgId: Id<"organizations">;
      schedulerId?: Id<"_scheduled_functions">;
      _id: Id<"costAlertMonitors">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "lastError"
      | "lastEvaluatedAt"
      | "nextEvaluationAt"
      | "orgId"
      | "schedulerId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_next_evaluation: ["nextEvaluationAt", "_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  costAlerts: {
    document: {
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
      _id: Id<"costAlerts">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "apiKeyIds"
      | "channelIds"
      | "condition"
      | "condition.approvedModels"
      | "condition.baselineHours"
      | "condition.minCurrentHourUsd"
      | "condition.minIncreaseUsd"
      | "condition.multiplier"
      | "condition.thresholdUsd"
      | "condition.type"
      | "condition.window"
      | "cooldownMinutes"
      | "createdAt"
      | "createdByUserId"
      | "enabled"
      | "name"
      | "notifyOnRecovery"
      | "orgId"
      | "severity"
      | "scope"
      | "scope.baggageOperation"
      | "scope.baggageUserId"
      | "scope.model"
      | "scope.provider"
      | "updatedAt"
      | "updatedByUserId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  costAlertStates: {
    document: {
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
      _id: Id<"costAlertStates">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "active"
      | "costAlertId"
      | "lastDeliveryError"
      | "lastEvaluatedAt"
      | "lastMetricLabel"
      | "lastMetricValue"
      | "lastNotificationAt"
      | "lastRecoveredAt"
      | "lastSummary"
      | "lastTriggeredAt"
      | "orgId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_alert_id: ["costAlertId", "_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  feedback: {
    document: {
      message: string;
      userId: Id<"users">;
      _id: Id<"feedback">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "message" | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  invites: {
    document: {
      acceptedAt?: number;
      email: string;
      expiresAt: number;
      invitedBy: Id<"users">;
      orgId?: Id<"organizations">;
      status: "pending" | "accepted" | "expired";
      token: string;
      _id: Id<"invites">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "acceptedAt"
      | "email"
      | "expiresAt"
      | "invitedBy"
      | "orgId"
      | "status"
      | "token";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_email: ["email", "_creationTime"];
      by_org_id_status: ["orgId", "status", "_creationTime"];
      by_status: ["status", "_creationTime"];
      by_token: ["token", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  mcpAuthCodes: {
    document: {
      auth0RefreshToken: string;
      clientId?: string;
      code: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
      expiresAt: number;
      redirectUri: string;
      resource?: string;
      used: boolean;
      userId: Id<"users">;
      _id: Id<"mcpAuthCodes">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "auth0RefreshToken"
      | "clientId"
      | "code"
      | "codeChallenge"
      | "codeChallengeMethod"
      | "expiresAt"
      | "redirectUri"
      | "resource"
      | "used"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_code: ["code", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  mcpClients: {
    document: {
      clientId: string;
      clientName?: string;
      redirectUris: Array<string>;
      _id: Id<"mcpClients">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "clientId"
      | "clientName"
      | "redirectUris";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_client_id: ["clientId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  mcpRefreshTokens: {
    document: {
      auth0RefreshToken: string;
      clientId?: string;
      expiresAt: number;
      hashedTokenId: string;
      resource?: string;
      tokenId?: string;
      userId: Id<"users">;
      _id: Id<"mcpRefreshTokens">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "auth0RefreshToken"
      | "clientId"
      | "expiresAt"
      | "hashedTokenId"
      | "resource"
      | "tokenId"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_token_id: ["hashedTokenId", "_creationTime"];
      by_user_id: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  mcpSessions: {
    document: {
      expiresAt: number;
      protocolVersion: string;
      sessionId: string;
      state: "initializing" | "ready" | "shutdown";
      userId: Id<"users">;
      _id: Id<"mcpSessions">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "expiresAt"
      | "protocolVersion"
      | "sessionId"
      | "state"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_session_id: ["sessionId", "_creationTime"];
      by_user_id: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  modelPricing: {
    document: {
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
      _id: Id<"modelPricing">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "cacheReadCostPerMillion"
      | "cacheWrite1hCostPerMillion"
      | "cacheWriteCostPerMillion"
      | "completionCostPerMillion"
      | "contextTier"
      | "contextTier.cacheReadCostPerMillion"
      | "contextTier.cacheWrite1hCostPerMillion"
      | "contextTier.cacheWriteCostPerMillion"
      | "contextTier.completionCostPerMillion"
      | "contextTier.promptCostPerMillion"
      | "contextTier.reasoningCostPerMillion"
      | "contextTier.thresholdTokens"
      | "model"
      | "promptCostPerMillion"
      | "provider"
      | "reasoningCostPerMillion"
      | "source"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_provider: ["provider", "_creationTime"];
      by_provider_model: ["provider", "model", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  organizationMembers: {
    document: {
      invitedAt?: number;
      joinedAt?: number;
      orgId: Id<"organizations">;
      removedAt?: number;
      role: "owner" | "member";
      status: "active" | "removed";
      userId: Id<"users">;
      _id: Id<"organizationMembers">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "invitedAt"
      | "joinedAt"
      | "orgId"
      | "removedAt"
      | "role"
      | "status"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_org_id_status: ["orgId", "status", "_creationTime"];
      by_user_id: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  organizations: {
    document: {
      deletedAt?: number;
      name: string;
      onboardingCompletedAt?: number;
      ownerId: Id<"users">;
      stripeCustomerId?: string;
      _id: Id<"organizations">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "deletedAt"
      | "name"
      | "onboardingCompletedAt"
      | "ownerId"
      | "stripeCustomerId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_owner_id: ["ownerId", "_creationTime"];
      by_stripe_customer_id: ["stripeCustomerId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  stripeEvents: {
    document: {
      error?: string;
      eventId: string;
      eventType: string;
      processedAt?: number;
      processingStartedAt?: number;
      status: "processing" | "processed" | "failed";
      stripeObjectId?: string;
      _id: Id<"stripeEvents">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "error"
      | "eventId"
      | "eventType"
      | "processedAt"
      | "processingStartedAt"
      | "status"
      | "stripeObjectId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_event_id: ["eventId", "_creationTime"];
      by_status: ["status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  subscriptions: {
    document: {
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
      _id: Id<"subscriptions">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "addonPurchaseCount"
      | "addonUnits"
      | "autoOverage"
      | "autoTopupPendingSince"
      | "cancelAtPeriodEnd"
      | "currentPeriodEnd"
      | "currentPeriodOverageSpentCents"
      | "currentPeriodStart"
      | "deletionSchedulerId"
      | "gracePeriodSchedulerId"
      | "monthlyUnits"
      | "orgId"
      | "overageCapCents"
      | "status"
      | "stripeCustomerId"
      | "stripePlanItemId"
      | "stripeSubscriptionId"
      | "tier";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_stripe_customer_id: ["stripeCustomerId", "_creationTime"];
      by_stripe_subscription_id: ["stripeSubscriptionId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  usage: {
    document: {
      addonUnitsUsed: number;
      orgId: Id<"organizations">;
      periodEnd: number;
      periodStart: number;
      subscriptionUnitsUsed: number;
      _id: Id<"usage">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "addonUnitsUsed"
      | "orgId"
      | "periodEnd"
      | "periodStart"
      | "subscriptionUnitsUsed";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id_period: ["orgId", "periodStart", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  users: {
    document: {
      email: string;
      enabled: boolean;
      inviteId?: Id<"invites">;
      isAdmin?: boolean;
      name?: string;
      orgId?: Id<"organizations">;
      picture?: string;
      tokenIdentifier: string;
      _id: Id<"users">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "email"
      | "enabled"
      | "inviteId"
      | "isAdmin"
      | "name"
      | "orgId"
      | "picture"
      | "tokenIdentifier";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
      by_token_identifier: ["tokenIdentifier", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  waitlist: {
    document: {
      confirmationToken: string;
      confirmed: boolean;
      email: string;
      notifiedAt?: number;
      source?: string;
      _id: Id<"waitlist">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "confirmationToken"
      | "confirmed"
      | "email"
      | "notifiedAt"
      | "source";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_confirmation_token: ["confirmationToken", "_creationTime"];
      by_email: ["email", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
};

/**
 * The names of all of your Convex tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in Convex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;

/**
 * An identifier for a document in Convex.
 *
 * Convex documents are uniquely identified by their `Id`, which is accessible
 * on the `_id` field. To learn more, see [Document IDs](https://docs.convex.dev/using/document-ids).
 *
 * Documents can be loaded using `db.get(tableName, id)` in query and mutation functions.
 *
 * IDs are just strings at runtime, but this type can be used to distinguish them from other
 * strings when type checking.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;
