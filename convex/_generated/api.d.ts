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
import type * as careers from "../careers.js";
import type * as careersRead from "../careersRead.js";
import type * as chat from "../chat.js";
import type * as chatText from "../chatText.js";
import type * as companies from "../companies.js";
import type * as companyLists from "../companyLists.js";
import type * as crons from "../crons.js";
import type * as erase from "../erase.js";
import type * as evalScore from "../evalScore.js";
import type * as evals from "../evals.js";
import type * as grade from "../grade.js";
import type * as guests from "../guests.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as joinPage from "../joinPage.js";
import type * as limits from "../limits.js";
import type * as photos from "../photos.js";
import type * as privacy from "../privacy.js";
import type * as profile from "../profile.js";
import type * as resume from "../resume.js";
import type * as understand from "../understand.js";
import type * as whatsapp from "../whatsapp.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  careers: typeof careers;
  careersRead: typeof careersRead;
  chat: typeof chat;
  chatText: typeof chatText;
  companies: typeof companies;
  companyLists: typeof companyLists;
  crons: typeof crons;
  erase: typeof erase;
  evalScore: typeof evalScore;
  evals: typeof evals;
  grade: typeof grade;
  guests: typeof guests;
  history: typeof history;
  http: typeof http;
  jobs: typeof jobs;
  joinPage: typeof joinPage;
  limits: typeof limits;
  photos: typeof photos;
  privacy: typeof privacy;
  profile: typeof profile;
  resume: typeof resume;
  understand: typeof understand;
  whatsapp: typeof whatsapp;
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

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
