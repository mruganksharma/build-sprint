import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const insertEvent = internalMutation({
  args: {
    schema_version: v.number(),
    event_timestamp: v.string(),
    skill_version: v.string(),
    os: v.string(),
    arch: v.optional(v.string()),
    duration_s: v.optional(v.number()),
    outcome: v.string(),
    mode: v.optional(v.string()),
    steps_run: v.optional(v.string()),
    self_rating: v.optional(v.number()),
    installation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("telemetry_events", args);
  },
});

export const upsertInstallation = internalMutation({
  args: {
    installation_id: v.string(),
    skill_version: v.string(),
    os: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("installations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installation_id", args.installation_id)
      )
      .unique();

    const now = new Date().toISOString();
    if (existing) {
      await ctx.db.patch(existing._id, {
        last_seen: now,
        skill_version: args.skill_version,
        os: args.os,
      });
    } else {
      await ctx.db.insert("installations", {
        installation_id: args.installation_id,
        first_seen: now,
        last_seen: now,
        skill_version: args.skill_version,
        os: args.os,
      });
    }
  },
});
