import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { type Check, type Score, scoreOfFour } from "./evalScore";

// Observability: every output of the agent, with what went in and a score against the rubric:
//   document_read  role, industry, location and the document itself read correctly (graded by a
//                  separate Claude check, see grade.ts)
//   preference     the search used their role, industry, location and job sites (rules)
//   jobs_found     5+ new jobs that match role, industry and location (rules)
//   job_fit        only from the user's own yes/no replies to the jobs sent (never AI)
// Read them with:  npm run dashboard

const MAX_JSON_CHARS = 30000;
const levelValidator = v.union(v.literal("best"), v.literal("between"), v.literal("worst"), v.literal("pending"));
const checkValidator = v.object({ item: v.string(), ok: v.boolean(), note: v.string() });

const json = (value: unknown) => {
  const text = JSON.stringify(value, null, 1);
  return text.length > MAX_JSON_CHARS ? text.slice(0, MAX_JSON_CHARS) + "\n…(cut)" : text;
};

export const log = internalMutation({
  args: {
    phone: v.string(),
    lever: v.union(v.literal("document_read"), v.literal("preference"), v.literal("jobs_found"), v.literal("job_fit")),
    searchId: v.optional(v.id("searches")),
    input: v.any(),
    output: v.any(),
    score: levelValidator,
    checks: v.array(checkValidator),
    judgedBy: v.union(v.literal("rules"), v.literal("claude"), v.literal("user_replies")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("evals", { ...args, input: json(args.input), output: json(args.output), updatedAt: Date.now() });
    return null;
  },
});

// ---------- Preference and Jobs Found: scored by rules, right after a search ----------

type SearchFacts = {
  phone: string;
  searchId: Id<"searches">;
  alert: boolean;
  search: string; // what was asked of LinkedIn, e.g. "Senior PM Fintech" in Mumbai, last 7 days
  role: string;
  preferences: { role?: string; industries?: string[]; location?: string; portals?: string[]; days?: number } | null;
  skipped: string[]; // industries LinkedIn turned away
  shown: { jobId: string; title: string; company: string; location: string; fit: string; brokenPreference: string | null }[];
  counts: Record<string, number>;
};

export const logSearch = internalMutation({
  args: { facts: v.any() },
  returns: v.null(),
  handler: async (ctx, { facts }) => {
    const f = facts as SearchFacts;
    const prefs = f.preferences ?? {};
    const city = (prefs.location ?? "India").toLowerCase();
    const searched = f.search.toLowerCase();
    const input = { search: f.search, alert: f.alert, preferences: prefs, role: f.role };

    // Preference: did the search use what they asked for?
    const industries = prefs.industries ?? [];
    const missingIndustries = industries.filter((i) => !searched.includes(i.toLowerCase()) || f.skipped.includes(i));
    const portals = prefs.portals ?? [];
    const preference: Check[] = [
      { item: "role", ok: searched.includes(f.role.toLowerCase()), note: `searched for "${f.role}"${prefs.role ? ` (they asked for "${prefs.role}")` : " (from their resume)"}` },
      {
        item: "industry",
        ok: missingIndustries.length === 0,
        note: industries.length ? (missingIndustries.length ? `not searched: ${missingIndustries.join(", ")}` : `searched: ${industries.join(", ")}`) : "no industry asked for",
      },
      { item: "location", ok: searched.includes(city.split(/[ ,]/)[0]), note: `asked for ${prefs.location ?? "(none, India)"}` },
      {
        item: "job portal",
        ok: portals.length === 0,
        note: portals.length ? `asked for ${portals.join(", ")}; only LinkedIn is searched today` : "no other site asked for; LinkedIn searched",
      },
    ];
    await ctx.db.insert("evals", {
      phone: f.phone, lever: "preference", searchId: f.searchId, input: json(input), output: json({ search: f.search, skipped: f.skipped }),
      score: scoreOfFour(preference), checks: preference, judgedBy: "rules", updatedAt: Date.now(),
    });

    // Jobs Found: how many new jobs, and do they match role, industry and location?
    const fresh = f.shown.length;
    const cityWord = city.split(/[ ,]/)[0];
    const wrongPlace = f.shown.filter((j) => !j.location.toLowerCase().includes(cityWord) && cityWord !== "india");
    const brokeRule = f.shown.filter((j) => j.brokenPreference);
    const found: Check[] = [
      { item: "5 or more new jobs", ok: fresh >= 5, note: `${fresh} new${f.counts.alreadySent ? `, ${f.counts.alreadySent} left out as already sent` : ""}` },
      { item: "role", ok: true, note: "every job passed the job-title filter" },
      { item: "industry", ok: brokeRule.length === 0, note: brokeRule.length ? `${brokeRule.length} broke a rule` : "no job broke their rules (from the fit check)" },
      { item: "location", ok: wrongPlace.length === 0, note: wrongPlace.length ? `${wrongPlace.length} not in ${prefs.location}: ${wrongPlace.map((j) => j.location).join("; ")}` : `all in ${prefs.location ?? "India"}` },
    ];
    const mismatches = found.slice(1).filter((c) => !c.ok).length;
    const byCount: Score = fresh >= 5 ? "best" : fresh >= 3 ? "between" : "worst";
    const byMatch: Score = mismatches === 0 ? "best" : mismatches === 1 ? "between" : "worst";
    const order: Score[] = ["worst", "between", "best"];
    await ctx.db.insert("evals", {
      phone: f.phone, lever: "jobs_found", searchId: f.searchId, input: json(input), output: json({ shown: f.shown, counts: f.counts }),
      score: order[Math.min(order.indexOf(byCount), order.indexOf(byMatch))], checks: found, judgedBy: "rules", updatedAt: Date.now(),
    });

    // Job Fit: waits for their replies (see recordRating).
    if (fresh > 0) {
      await ctx.db.insert("evals", {
        phone: f.phone, lever: "job_fit", searchId: f.searchId,
        input: json({ jobs: f.shown.map((j, i) => `${i + 1}. ${j.title} at ${j.company}`) }),
        output: json({ replies: {} }),
        score: "pending", checks: [{ item: "replies", ok: false, note: `0 of ${fresh} jobs rated yet` }], judgedBy: "user_replies", updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ---------- Job Fit: only from the user's yes/no replies ----------

// Called when the user rates job n of a search ("3 yes", "2 no", or the same in their own words).
// 3+ yes → best; 1-2 yes → between; every job rated and none yes → worst; otherwise pending.
export async function recordRating(ctx: MutationCtx, searchId: Id<"searches">, n: number, yes: boolean): Promise<void> {
  const row = await ctx.db
    .query("evals")
    .withIndex("by_searchId_and_lever", (q) => q.eq("searchId", searchId).eq("lever", "job_fit"))
    .first();
  if (!row) return;
  const jobs: string[] = JSON.parse(row.input).jobs ?? [];
  const replies: Record<string, "yes" | "no"> = JSON.parse(row.output).replies ?? {};
  replies[String(n)] = yes ? "yes" : "no";
  const yeses = Object.values(replies).filter((r) => r === "yes").length;
  const rated = Object.keys(replies).length;
  const score: Score = yeses >= 3 ? "best" : yeses >= 1 ? "between" : rated >= jobs.length ? "worst" : "pending";
  await ctx.db.patch(row._id, {
    output: json({ replies }),
    score,
    checks: [{ item: "replies", ok: yeses > 0, note: `${yeses} yes, ${rated - yeses} no, ${jobs.length - rated} not rated, of ${jobs.length} jobs` }],
    updatedAt: Date.now(),
  });
}

// ---------- For the dashboard ----------

export const page = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        _id: v.id("evals"),
        _creationTime: v.number(),
        phone: v.string(),
        lever: v.string(),
        searchId: v.optional(v.id("searches")),
        input: v.string(),
        output: v.string(),
        score: levelValidator,
        checks: v.array(checkValidator),
        judgedBy: v.string(),
        updatedAt: v.number(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, { paginationOpts }) => ctx.db.query("evals").withIndex("by_updatedAt").order("desc").paginate(paginationOpts),
});

// Every scored row for one number, newest first. For tests and checking from the terminal.
export const forPhone = internalQuery({
  args: { phone: v.string() },
  returns: v.array(v.object({ lever: v.string(), score: levelValidator, checks: v.array(checkValidator), judgedBy: v.string(), output: v.string() })),
  handler: async (ctx, { phone }) => {
    const rows = await ctx.db
      .query("evals")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(50);
    return rows.map(({ lever, score, checks, judgedBy, output }) => ({ lever, score, checks, judgedBy, output }));
  },
});
