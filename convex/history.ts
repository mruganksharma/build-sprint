import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { outcomeValidator } from "./schema";

// Milestone 4b: keep every search and every job it looked at, with the reason it was shown or not.

export const saveSearch = internalMutation({
  args: {
    phone: v.string(),
    search: v.string(),
    summary: v.string(),
    jobs: v.array(
      v.object({
        jobId: v.string(),
        title: v.string(),
        company: v.string(),
        location: v.string(),
        postedOn: v.string(),
        url: v.string(),
        outcome: outcomeValidator,
        fit: v.optional(v.union(v.literal("strong"), v.literal("partial"), v.literal("not_a_fit"))),
        reason: v.optional(v.string()),
        caveat: v.optional(v.string()),
        brokenPreference: v.optional(v.string()),
      }),
    ),
  },
  returns: v.id("searches"),
  handler: async (ctx, { phone, search, summary, jobs }) => {
    const searchId = await ctx.db.insert("searches", { phone, search, summary });
    for (const job of jobs) {
      await ctx.db.insert("jobsSeen", { phone, searchId, ...job });
    }
    return searchId;
  },
});

// Counts of what we've kept for one user. Run from the terminal:
//   npx convex run history:countsForPhone '{"phone": "15550000001"}'
export const countsForPhone = internalQuery({
  args: { phone: v.string() },
  returns: v.object({ searches: v.number(), jobs: v.number(), shown: v.number() }),
  handler: async (ctx, { phone }) => {
    const searches = await ctx.db.query("searches").withIndex("by_phone", (q) => q.eq("phone", phone)).take(100);
    const jobs = await ctx.db
      .query("jobsSeen")
      .withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone))
      .take(1000);
    return { searches: searches.length, jobs: jobs.length, shown: jobs.filter((j) => j.outcome === "shown").length };
  },
});

// The latest time a search looked at this job for this user, if ever.
export const findJob = internalQuery({
  args: { phone: v.string(), jobId: v.string() },
  returns: v.union(
    v.object({
      title: v.string(),
      company: v.string(),
      postedOn: v.string(),
      seenOn: v.number(),
      outcome: outcomeValidator,
      fit: v.union(v.literal("strong"), v.literal("partial"), v.literal("not_a_fit"), v.null()),
      reason: v.union(v.string(), v.null()),
      brokenPreference: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { phone, jobId }) => {
    const row = await ctx.db
      .query("jobsSeen")
      .withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone).eq("jobId", jobId))
      .order("desc")
      .first();
    if (!row) return null;
    return {
      title: row.title,
      company: row.company,
      postedOn: row.postedOn,
      seenOn: row._creationTime,
      outcome: row.outcome,
      fit: row.fit ?? null,
      reason: row.reason ?? null,
      brokenPreference: row.brokenPreference ?? null,
    };
  },
});
