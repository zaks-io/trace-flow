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
  invites: {
    document: {
      acceptedAt?: number;
      email: string;
      expiresAt: number;
      invitedBy: Id<"users">;
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
      | "status"
      | "token";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_email: ["email", "_creationTime"];
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
      expiresAt: number;
      tokenId: string;
      userId: Id<"users">;
      _id: Id<"mcpRefreshTokens">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "auth0RefreshToken"
      | "expiresAt"
      | "tokenId"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_token_id: ["tokenId", "_creationTime"];
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
      cacheWriteCostPerMillion?: number;
      completionCostPerMillion: number;
      model: string;
      promptCostPerMillion: number;
      provider: string;
      reasoningCostPerMillion?: number;
      source: "manual" | "openrouter" | "default";
      updatedAt: number;
      _id: Id<"modelPricing">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "cacheReadCostPerMillion"
      | "cacheWriteCostPerMillion"
      | "completionCostPerMillion"
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
  organizations: {
    document: {
      name: string;
      ownerId: Id<"users">;
      _id: Id<"organizations">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "name" | "ownerId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_owner_id: ["ownerId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  subscriptions: {
    document: {
      addonUnits: number;
      monthlyUnits: number;
      orgId: Id<"organizations">;
      tier: "hobby" | "pro";
      _id: Id<"subscriptions">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "addonUnits"
      | "monthlyUnits"
      | "orgId"
      | "tier";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_org_id: ["orgId", "_creationTime"];
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
