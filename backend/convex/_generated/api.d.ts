/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as amc from "../amc.js";
import type * as assets from "../assets.js";
import type * as assignments from "../assignments.js";
import type * as cleanupOrphans from "../cleanupOrphans.js";
import type * as dashboards from "../dashboards.js";
import type * as documents from "../documents.js";
import type * as generic from "../generic.js";
import type * as imports from "../imports.js";
import type * as invoices from "../invoices.js";
import type * as knowledgeBase from "../knowledgeBase.js";
import type * as logs from "../logs.js";
import type * as masters from "../masters.js";
import type * as movements from "../movements.js";
import type * as permissions from "../permissions.js";
import type * as purchaseOrders from "../purchaseOrders.js";
import type * as reports from "../reports.js";
import type * as storage from "../storage.js";
import type * as tickets from "../tickets.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  amc: typeof amc;
  assets: typeof assets;
  assignments: typeof assignments;
  cleanupOrphans: typeof cleanupOrphans;
  dashboards: typeof dashboards;
  documents: typeof documents;
  generic: typeof generic;
  imports: typeof imports;
  invoices: typeof invoices;
  knowledgeBase: typeof knowledgeBase;
  logs: typeof logs;
  masters: typeof masters;
  movements: typeof movements;
  permissions: typeof permissions;
  purchaseOrders: typeof purchaseOrders;
  reports: typeof reports;
  storage: typeof storage;
  tickets: typeof tickets;
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
