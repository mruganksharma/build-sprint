import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { startQuestions } from "./chat";
import { preferencesValidator, stageValidator } from "./schema";

// The owner's own row (no phone), used by the terminal commands below.
const ownerRow = (ctx: QueryCtx | MutationCtx) =>
  ctx.db.query("profile").withIndex("by_phone", (q) => q.eq("phone", undefined)).first();

// Save (or replace) the resume text. Run from the terminal:
//   npx convex run profile:setResume '{"resumeText": "..."}'
export const setResume = internalMutation({
  args: { resumeText: v.string() },
  returns: v.null(),
  handler: async (ctx, { resumeText }) => {
    const existing = await ownerRow(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, { resumeText, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("profile", { resumeText, updatedAt: Date.now() });
    }
    return null;
  },
});

export const getResume = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const row = await ownerRow(ctx);
    return row?.resumeText ?? null;
  },
});

// Save (or replace) the preferences. Pass {} to clear them. Run from the terminal:
//   npx convex run profile:setPreferences '{"industries": ["B2B SaaS"], "avoid": ["banks"]}'
export const setPreferences = internalMutation({
  args: preferencesValidator,
  returns: v.null(),
  handler: async (ctx, preferences) => {
    const existing = await ownerRow(ctx);
    if (!existing) throw new Error("No resume saved yet. Run profile:setResume first.");
    await ctx.db.patch(existing._id, { preferences, updatedAt: Date.now() });
    return null;
  },
});

export const getPreferences = internalQuery({
  args: {},
  returns: v.union(preferencesValidator, v.null()),
  handler: async (ctx) => {
    const row = await ownerRow(ctx);
    return row?.preferences ?? null;
  },
});

// A WhatsApp user's resume. Replaces their previous one (and deletes the old file), then starts
// the questions about what they're looking for. Returns the first question.
export const saveUserResume = internalMutation({
  args: {
    phone: v.string(),
    resumeText: v.string(),
    resumeSummary: v.string(),
    resumeFileId: v.optional(v.id("_storage")),
    resumeFileName: v.optional(v.string()),
    resumeExtraFileIds: v.optional(v.array(v.id("_storage"))),
    contactEmail: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    currentRole: v.optional(v.string()),
    currentIndustry: v.optional(v.string()),
    currentLocation: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
    const fields = {
      resumeText: args.resumeText,
      resumeSummary: args.resumeSummary,
      resumeFileId: args.resumeFileId,
      resumeFileName: args.resumeFileName,
      resumeExtraFileIds: args.resumeExtraFileIds,
      contactEmail: args.contactEmail,
      linkedinUrl: args.linkedinUrl,
      currentRole: args.currentRole,
      currentIndustry: args.currentIndustry,
      currentLocation: args.currentLocation,
      updatedAt: Date.now(),
    };
    if (existing) {
      const keep = new Set([args.resumeFileId, ...(args.resumeExtraFileIds ?? [])]);
      for (const old of [existing.resumeFileId, ...(existing.resumeExtraFileIds ?? [])]) {
        if (old && !keep.has(old)) await ctx.storage.delete(old);
      }
      await ctx.db.patch(existing._id, fields);
      return await startQuestions(ctx, { ...existing, ...fields });
    }
    const id = await ctx.db.insert("profile", { phone: args.phone, ...fields });
    return await startQuestions(ctx, (await ctx.db.get(id))!);
  },
});

// What we have on a WhatsApp user. Run from the terminal:
//   npx convex run profile:getByPhone '{"phone": "15550000001"}'
export const getByPhone = internalQuery({
  args: { phone: v.string() },
  returns: v.union(
    v.object({
      resumeSummary: v.union(v.string(), v.null()),
      resumeTextLength: v.number(),
      resumeText: v.string(),
      fileCount: v.number(),
      contactEmail: v.union(v.string(), v.null()),
      linkedinUrl: v.union(v.string(), v.null()),
      resumeFileName: v.union(v.string(), v.null()),
      hasFile: v.boolean(),
      currentIndustry: v.union(v.string(), v.null()),
      currentLocation: v.union(v.string(), v.null()),
      stage: v.union(stageValidator, v.null()),
      preferences: v.union(preferencesValidator, v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return null;
    return {
      resumeSummary: row.resumeSummary ?? null,
      resumeTextLength: row.resumeText.length,
      resumeText: row.resumeText,
      fileCount: (row.resumeFileId ? 1 : 0) + (row.resumeExtraFileIds?.length ?? 0),
      contactEmail: row.contactEmail ?? null,
      linkedinUrl: row.linkedinUrl ?? null,
      resumeFileName: row.resumeFileName ?? null,
      hasFile: row.resumeFileId !== undefined,
      currentIndustry: row.currentIndustry ?? null,
      currentLocation: row.currentLocation ?? null,
      stage: row.stage ?? null,
      preferences: row.preferences ?? null,
    };
  },
});

// A one-time upload address for Convex file storage. Used by the test script to send in made-up resumes.
export const uploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

// A public address for a stored file. Used by the test script to make a "website" holding a made-up resume.
export const fileUrl = internalQuery({
  args: { fileId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { fileId }) => await ctx.storage.getUrl(fileId),
});

// What a job search for a WhatsApp user needs.
export const getForSearch = internalQuery({
  args: { phone: v.string() },
  returns: v.union(
    v.object({
      resumeText: v.string(),
      role: v.union(v.string(), v.null()),
      preferences: v.union(preferencesValidator, v.null()),
      ready: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return null;
    return {
      resumeText: row.resumeText,
      role: row.preferences?.role ?? row.currentRole ?? null,
      preferences: row.preferences ?? null,
      ready: row.stage === "ready",
    };
  },
});

const SEARCH_LOCK_MS = 10 * 60 * 1000; // a search never takes this long; after it, assume it died

// Marks a search as running. Returns false if one is already running for this user.
export const startSearch = internalMutation({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return false;
    if (row.searchStartedAt && Date.now() - row.searchStartedAt < SEARCH_LOCK_MS) return false;
    await ctx.db.patch(row._id, { searchStartedAt: Date.now() });
    return true;
  },
});

export const finishSearch = internalMutation({
  args: { phone: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, { searchStartedAt: undefined, searchQueued: undefined });
    // They changed what they're looking for while this search ran: search again with the new answers.
    if (row.searchQueued) await ctx.scheduler.runAfter(0, internal.jobs.searchForUser, { phone, announce: true });
    return null;
  },
});

// Test helper: pretend a job search is running for a made-up number. Run from the test scripts only.
export const markSearchingForTest = internalMutation({
  args: { phone: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (row) await ctx.db.patch(row._id, { searchStartedAt: Date.now() });
    return null;
  },
});
