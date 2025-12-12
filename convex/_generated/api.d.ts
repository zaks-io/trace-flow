/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as cloudflare from "../cloudflare.js";
import type * as defaultPricing from "../defaultPricing.js";
import type * as http from "../http.js";
import type * as mcp_clients from "../mcp/clients.js";
import type * as mcp_handler from "../mcp/handler.js";
import type * as mcp_oauth from "../mcp/oauth.js";
import type * as mcp_protocol from "../mcp/protocol.js";
import type * as mcp_session from "../mcp/session.js";
import type * as mcp_tokens from "../mcp/tokens.js";
import type * as mcp_tools from "../mcp/tools.js";
import type * as modelPricing from "../modelPricing.js";
import type * as pricingSync from "../pricingSync.js";
import type * as tinybird from "../tinybird.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  cloudflare: typeof cloudflare;
  defaultPricing: typeof defaultPricing;
  http: typeof http;
  "mcp/clients": typeof mcp_clients;
  "mcp/handler": typeof mcp_handler;
  "mcp/oauth": typeof mcp_oauth;
  "mcp/protocol": typeof mcp_protocol;
  "mcp/session": typeof mcp_session;
  "mcp/tokens": typeof mcp_tokens;
  "mcp/tools": typeof mcp_tools;
  modelPricing: typeof modelPricing;
  pricingSync: typeof pricingSync;
  tinybird: typeof tinybird;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
