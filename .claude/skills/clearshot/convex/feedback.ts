import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const insertReport = internalMutation({
  args: {
    submitted_at: v.string(),
    skill_version: v.string(),
    self_rating: v.number(),
    mode: v.string(),
    steps_run: v.string(),
    why_not_10: v.string(),
    what_would_make_10: v.string(),
    os: v.optional(v.string()),
    installation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("feedback_reports", args);
  },
});
