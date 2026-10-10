import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { outcomeValidator } from "./schema";

// Milestone 4b: keep every search and every job it looked at, with the reason it was shown or not.

export const saveSearch = internalMutation({
  args: {
    phone: v.string(),
    search: v.string(),
    summary: v.string(),
    shown: v.array(v.string()),
    closeShown: v.optional(v.array(v.string())),
    matchKey: v.string(),
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
  handler: async (ctx, { phone, search, summary, shown, closeShown, matchKey, jobs }) => {
    const searchId = await ctx.db.insert("searches", { phone, search, summary, shown, closeShown, matchKey });
    for (const job of jobs) {
      await ctx.db.insert("jobsSeen", { phone, searchId, matchKey, ...job });
    }
    return searchId;
  },
});

// What each search did with its jobs, newest search first. Run from the terminal:
//   npx convex run history:countsForPhone '{"phone": "15550000001"}'
export const countsForPhone = internalQuery({
  args: { phone: v.string() },
  returns: v.object({
    searches: v.number(),
    jobs: v.number(),
    shown: v.number(),
    perSearch: v.array(v.record(v.string(), v.number())),
  }),
  handler: async (ctx, { phone }) => {
    const searches = await ctx.db.query("searches").withIndex("by_phone", (q) => q.eq("phone", phone)).order("desc").take(20);
    const jobs = await ctx.db
      .query("jobsSeen")
      .withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone))
      .take(1000);
    const perSearch = searches.map((search) => {
      const counts: Record<string, number> = {};
      for (const job of jobs) if (job.searchId === search._id) counts[job.outcome] = (counts[job.outcome] ?? 0) + 1;
      return counts;
    });
    return { searches: searches.length, jobs: jobs.length, shown: jobs.filter((j) => j.outcome === "shown").length, perSearch };
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

// Jobs Claude already judged for this user recently, with the same resume and hard preferences
// (matchKey). A new search reuses these instead of asking Claude again.
export const recentVerdicts = internalQuery({
  args: { phone: v.string(), matchKey: v.string(), since: v.number() },
  returns: v.array(
    v.object({
      jobId: v.string(),
      outcome: outcomeValidator,
      fit: v.union(v.literal("strong"), v.literal("partial"), v.literal("not_a_fit")),
      reason: v.string(),
      caveat: v.union(v.string(), v.null()),
      brokenPreference: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { phone, matchKey, since }) => {
    const rows = await ctx.db
      .query("jobsSeen")
      .withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone))
      .order("desc")
      .take(500);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row._creationTime < since || row.matchKey !== matchKey || !row.fit || !row.reason) continue;
      if (!latest.has(row.jobId)) latest.set(row.jobId, row);
    }
    return [...latest.values()].map((row) => ({
      jobId: row.jobId,
      outcome: row.outcome,
      fit: row.fit!,
      reason: row.reason!,
      caveat: row.caveat ?? null,
      brokenPreference: row.brokenPreference ?? null,
    }));
  },
});

// Jobs we've sent this user since `since`, whatever they were searching for at the time, so a job
// isn't sent again as "new" after they change what they're looking for. Also the close-but-not-quite
// jobs we've listed, so those aren't listed twice either.
export const sentJobIds = internalQuery({
  args: { phone: v.string(), since: v.number() },
  returns: v.object({ sent: v.array(v.string()), listedClose: v.array(v.string()) }),
  handler: async (ctx, { phone, since }) => {
    const searches = (
      await ctx.db
        .query("searches")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .order("desc")
        .take(100)
    ).filter((s) => s._creationTime >= since);
    return {
      sent: [...new Set(searches.flatMap((s) => s.shown ?? []))],
      listedClose: [...new Set(searches.flatMap((s) => s.closeShown ?? []))],
    };
  },
});
