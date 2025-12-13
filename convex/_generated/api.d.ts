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
import type * as mcp_helpers_getTrace from "../mcp/helpers/getTrace.js";
import type * as mcp_helpers_index from "../mcp/helpers/index.js";
import type * as mcp_helpers_listTraces from "../mcp/helpers/listTraces.js";
import type * as mcp_oauth from "../mcp/oauth.js";
import type * as mcp_protocol from "../mcp/protocol.js";
import type * as mcp_session from "../mcp/session.js";
import type * as mcp_tokens from "../mcp/tokens.js";
import type * as mcp_tools_definitions from "../mcp/tools/definitions.js";
import type * as mcp_tools_getTrace from "../mcp/tools/getTrace.js";
import type * as mcp_tools_index from "../mcp/tools/index.js";
import type * as mcp_tools_listTraces from "../mcp/tools/listTraces.js";
import type * as mcp_tools_shared from "../mcp/tools/shared.js";
import type * as mcp_tools from "../mcp/tools.js";
import type * as mcp_utils from "../mcp/utils.js";
import type * as modelPricing from "../modelPricing.js";
import type * as pricingSync from "../pricingSync.js";
import type * as tinybird from "../tinybird.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  cloudflare: typeof cloudflare;
  defaultPricing: typeof defaultPricing;
  http: typeof http;
  "mcp/clients": typeof mcp_clients;
  "mcp/handler": typeof mcp_handler;
  "mcp/helpers/getTrace": typeof mcp_helpers_getTrace;
  "mcp/helpers/index": typeof mcp_helpers_index;
  "mcp/helpers/listTraces": typeof mcp_helpers_listTraces;
  "mcp/oauth": typeof mcp_oauth;
  "mcp/protocol": typeof mcp_protocol;
  "mcp/session": typeof mcp_session;
  "mcp/tokens": typeof mcp_tokens;
  "mcp/tools/definitions": typeof mcp_tools_definitions;
  "mcp/tools/getTrace": typeof mcp_tools_getTrace;
  "mcp/tools/index": typeof mcp_tools_index;
  "mcp/tools/listTraces": typeof mcp_tools_listTraces;
  "mcp/tools/shared": typeof mcp_tools_shared;
  "mcp/tools": typeof mcp_tools;
  "mcp/utils": typeof mcp_utils;
  modelPricing: typeof modelPricing;
  pricingSync: typeof pricingSync;
  tinybird: typeof tinybird;
  users: typeof users;
}>;
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

export declare const components: {};
