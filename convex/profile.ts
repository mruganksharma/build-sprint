import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { preferencesValidator } from "./schema";

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

// A WhatsApp user's resume. Replaces their previous one (and deletes the old file).
export const saveUserResume = internalMutation({
  args: {
    phone: v.string(),
    resumeText: v.string(),
    resumeSummary: v.string(),
    resumeFileId: v.optional(v.id("_storage")),
    resumeFileName: v.optional(v.string()),
  },
  returns: v.null(),
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
      updatedAt: Date.now(),
    };
    if (existing) {
      if (existing.resumeFileId && existing.resumeFileId !== args.resumeFileId) {
        await ctx.storage.delete(existing.resumeFileId);
      }
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("profile", { phone: args.phone, ...fields });
    }
    return null;
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
      resumeFileName: v.union(v.string(), v.null()),
      hasFile: v.boolean(),
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
      resumeFileName: row.resumeFileName ?? null,
      hasFile: row.resumeFileId !== undefined,
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
