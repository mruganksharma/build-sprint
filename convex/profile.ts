import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Save (or replace) the resume text. Run from the terminal:
//   npx convex run profile:setResume '{"resumeText": "..."}'
export const setResume = internalMutation({
  args: { resumeText: v.string() },
  returns: v.null(),
  handler: async (ctx, { resumeText }) => {
    const existing = await ctx.db.query("profile").first();
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
    const row = await ctx.db.query("profile").first();
    return row?.resumeText ?? null;
  },
});
