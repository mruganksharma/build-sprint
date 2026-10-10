import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { preferencesValidator } from "./schema";
import {
  METROS,
  allSet,
  industryInputQuestion,
  industryQuestion,
  locationQuestion,
  metroQuestion,
  noAngleBrackets,
  savedForNext,
  searchQueuedText,
  DAYS,
  daysQuestion,
  noListYet,
  noSuchJob,
  portalNoted,
  ratedJob,
  searchingAgain,
  stillSearching,
  likedReply,
  dislikedReply,
} from "./chatText";

// Milestone 4: after the resume, ask which industry and which city the user wants, one question
// at a time, and save the answers to their preferences. Short, clear answers need no AI; anything
// else is read by Claude (understand.ts) and saved with applyUnderstood below.

const MAX_INDUSTRY_CHARS = 100;
const MAX_CITY_CHARS = 60;
const SEARCH_LOCK_MS = 10 * 60 * 1000;
const MAX_FEEDBACK = 10; // most recent likes and dislikes kept per user

// Handles a short text message from a WhatsApp user. Clear, short answers (a number, "same",
// "jobs", "3 no") are handled here at once, with no AI. Returns { reply: null } when the message
// needs Claude to understand it (see understand.ts), or null if we have no resume for them yet.
export const handleAnswer = internalMutation({
  args: { phone: v.string(), text: v.string() },
  returns: v.union(v.object({ reply: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx, { phone, text }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return null;
    const answer = text.trim();
    const word = answer.toLowerCase();
    if (/[<>]/.test(answer)) return { reply: noAngleBrackets };
    const reply = await quickAnswer(ctx, row, answer, word);
    // Never send the same fixed message twice in a row: let Claude answer what they actually said.
    if (reply !== null && reply === (await lastSent(ctx, phone))) return { reply: null };
    return { reply };
  },
});

const SHORT_WORDS = 3; // longer messages say more than a plain answer, so Claude reads them
const isShort = (answer: string) => answer.split(/\s+/).length <= SHORT_WORDS;

// The reply to a clear answer, or null when the message needs Claude.
async function quickAnswer(ctx: MutationCtx, row: Doc<"profile">, answer: string, word: string): Promise<string | null> {
  if (!isShort(answer)) return null;
  switch (row.stage) {
    case "industry_choice": {
      const industry = row.currentIndustry ?? "";
      if (word === "1" || word.startsWith("same")) return askLocation(ctx, row, { industries: [industry] });
      if (word === "2" || word.startsWith("diff")) {
        await ctx.db.patch(row._id, { stage: "industry_input", updatedAt: Date.now() });
        return industryInputQuestion;
      }
      return null;
    }
    case "industry_input": {
      const industries = answer
        .split(/,|\/|\band\b|\n/i)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (!industries.length || answer.length > MAX_INDUSTRY_CHARS) return null;
      return askLocation(ctx, row, { industries });
    }
    case "location_choice": {
      const current = row.currentLocation ?? "";
      if (word === "1" || word.startsWith("same") || word === current.toLowerCase()) {
        return askDays(ctx, row, current);
      }
      if (word === "2" || word.startsWith("somewhere") || word.startsWith("diff") || word.startsWith("else")) {
        await ctx.db.patch(row._id, { stage: "location_input", updatedAt: Date.now() });
        return metroQuestion;
      }
      return null;
    }
    case "location_input": {
      const pick = Number(word);
      if (Number.isInteger(pick) && pick >= 1 && pick <= METROS.length) return askDays(ctx, row, METROS[pick - 1]);
      if (!/\p{L}/u.test(answer) || answer.length > MAX_CITY_CHARS) return null;
      return askDays(ctx, row, answer);
    }
    case "days_choice": {
      // Check 30 and 7 before 24: "last 30 days" also contains "day".
      const days =
        word === "3" || /\b30\b|month/.test(word) ? 30
        : word === "2" || /\b7\b|week/.test(word) ? 7
        : word === "1" || /\b24\b|\bday\b|today|hours?/.test(word) ? 1
        : null;
      return days ? finish(ctx, row, days) : null;
    }
    case "portal_input": {
      if (isCommand(word)) {
        await ctx.db.patch(row._id, { stage: "ready", updatedAt: Date.now() });
        return readyAnswer(ctx, { ...row, stage: "ready" }, word);
      }
      if (!/\p{L}/u.test(answer) || answer.length > MAX_CITY_CHARS) return null;
      await addPortals(ctx, row, [answer], { stage: "ready" });
      return portalNoted(answer);
    }
    case "job_feedback": {
      const job = row.pendingJob ?? "";
      const yes = word === "1" || word.startsWith("yes");
      const no = word === "2" || word.startsWith("no");
      if (yes || no) {
        await saveFeedback(ctx, row, job, yes, { stage: "ready", pendingJob: undefined });
        return yes ? likedReply : dislikedReply;
      }
      if (!isCommand(word)) return null;
      await ctx.db.patch(row._id, { stage: "ready", pendingJob: undefined, updatedAt: Date.now() });
      return readyAnswer(ctx, { ...row, stage: "ready" }, word);
    }
    default:
      return readyAnswer(ctx, row, word);
  }
}

// After the questions: "change", "jobs", "3 no". Anything else goes to Claude (null).
async function readyAnswer(ctx: MutationCtx, row: Doc<"profile">, word: string): Promise<string | null> {
  if (/^(change|update|preferences?)$/.test(word)) return startQuestions(ctx, row);
  const rating = parseRating(word);
  if (rating && row.stage === "ready") return rateFromList(ctx, row, rating.n, rating.yes);
  if (/^(jobs?|search|more|again)$/.test(word) && row.stage === "ready") return searchNow(ctx, row);
  return null;
}

async function searchNow(ctx: MutationCtx, row: Doc<"profile">): Promise<string> {
  if (isSearching(row)) return stillSearching;
  await ctx.scheduler.runAfter(0, internal.jobs.searchForUser, { phone: row.phone!, announce: false });
  return searchingAgain(row.preferences?.industries ?? [], row.preferences?.location ?? "India");
}

const isSearching = (row: Doc<"profile">) => !!row.searchStartedAt && Date.now() - row.searchStartedAt < SEARCH_LOCK_MS;

async function lastSent(ctx: MutationCtx, phone: string): Promise<string | null> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .order("desc")
    .take(10);
  return recent.find((m) => m.direction === "out")?.text ?? null;
}

// The same check for someone with no resume yet, so a second "hi" isn't met with the same welcome.
export const lastReply = internalQuery({
  args: { phone: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { phone }) => {
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(10);
    return recent.find((m) => m.direction === "out")?.text ?? null;
  },
});

// ---------- Messages Claude understood (see understand.ts) ----------

const MAX_CHAT_LINES = 8; // recent messages Claude sees, to understand a reply like "no" or "yes, that one"
const MAX_LIST = 5; // industries kept
const MAX_RULES = 10; // avoid / must-have rules kept

// What Claude needs to understand a message: where the user is in the chat and what they've asked for.
export const understandContext = internalQuery({
  args: { phone: v.string() },
  returns: v.object({
    hasResume: v.boolean(),
    summary: v.union(v.string(), v.null()),
    stage: v.union(v.string(), v.null()),
    pendingQuestion: v.union(v.string(), v.null()),
    currentIndustry: v.union(v.string(), v.null()),
    currentLocation: v.union(v.string(), v.null()),
    preferences: v.union(preferencesValidator, v.null()),
    searching: v.boolean(),
    lastJobs: v.array(v.string()),
    chat: v.array(v.object({ from: v.union(v.literal("user"), v.literal("app")), text: v.string() })),
  }),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(MAX_CHAT_LINES + 1);
    // The newest message is the one being understood; it's sent to Claude separately.
    const chat = recent
      .slice(1)
      .reverse()
      .map((m) => ({ from: m.direction === "in" ? ("user" as const) : ("app" as const), text: (m.text ?? `[${m.type}]`).slice(0, 1500) }));
    const lastJobs: string[] = [];
    if (row) {
      const searches = await ctx.db
        .query("searches")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .order("desc")
        .take(10);
      const shown = searches.find((s) => s.shown?.length)?.shown ?? [];
      for (const jobId of shown) {
        const seen = await ctx.db
          .query("jobsSeen")
          .withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone).eq("jobId", jobId))
          .order("desc")
          .first();
        lastJobs.push(seen ? `${seen.title} at ${seen.company}` : "(unknown job)");
      }
    }
    return {
      hasResume: !!row,
      summary: row?.resumeSummary ?? null,
      stage: row?.stage ?? null,
      pendingQuestion: row ? questionFor(row) : null,
      currentIndustry: row?.currentIndustry ?? null,
      currentLocation: row?.currentLocation ?? null,
      preferences: row?.preferences ?? null,
      searching: !!row && isSearching(row),
      lastJobs,
      chat,
    };
  },
});

// The question the user is in the middle of answering, if any.
function questionFor(row: Doc<"profile">): string | null {
  switch (row.stage) {
    case "industry_choice": return industryQuestion(row.currentIndustry ?? "");
    case "industry_input": return industryInputQuestion;
    case "location_choice": return locationQuestion(row.currentLocation ?? "");
    case "location_input": return metroQuestion;
    case "days_choice": return daysQuestion;
    case "job_feedback": return `Do you want more jobs like ${row.pendingJob ?? "that one"}?`;
    case "portal_input": return "Is there another job site you'd like me to search?";
    default: return null;
  }
}

const SETUP_STAGES = ["industry_choice", "industry_input", "location_choice", "location_input", "days_choice"];

// Saves what Claude understood from a message, starts a search if it should, and returns the reply.
export const applyUnderstood = internalMutation({
  args: {
    phone: v.string(),
    reply: v.string(),
    role: v.union(v.string(), v.null()),
    industries: v.union(v.array(v.string()), v.null()),
    industriesMode: v.union(v.literal("add"), v.literal("replace"), v.null()),
    location: v.union(v.string(), v.null()),
    days: v.union(v.number(), v.null()),
    avoid: v.union(v.array(v.string()), v.null()),
    mustHaves: v.union(v.array(v.string()), v.null()),
    jobSites: v.union(v.array(v.string()), v.null()),
    rateJob: v.union(v.object({ number: v.number(), liked: v.boolean() }), v.null()),
    startOver: v.boolean(),
    search: v.boolean(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
    if (!row) return args.reply; // no resume yet: nothing to save
    if (args.startOver) return `${args.reply}\n\n${await startQuestions(ctx, row)}`;

    const clean = (list: string[] | null) => (list ?? []).map((s) => s.trim().slice(0, MAX_INDUSTRY_CHARS)).filter(Boolean);
    const before = row.preferences ?? {};
    const prefs = { ...before };
    const newIndustries = clean(args.industries);
    if (newIndustries.length) {
      const base = args.industriesMode === "add" ? before.industries ?? [] : [];
      prefs.industries = dedupe([...base, ...newIndustries]).slice(0, MAX_LIST);
    }
    if (args.role?.trim()) prefs.role = args.role.trim().slice(0, MAX_INDUSTRY_CHARS);
    if (args.location?.trim()) prefs.location = args.location.trim().slice(0, MAX_CITY_CHARS);
    if (args.days) prefs.days = Math.min(30, Math.max(1, Math.round(args.days)));
    const avoid = clean(args.avoid);
    if (avoid.length) prefs.avoid = dedupe([...(before.avoid ?? []), ...avoid]).slice(-MAX_RULES);
    const mustHaves = clean(args.mustHaves);
    if (mustHaves.length) prefs.mustHaves = dedupe([...(before.mustHaves ?? []), ...mustHaves]).slice(-MAX_RULES);
    const sites = clean(args.jobSites);
    if (sites.length) prefs.portals = dedupe([...(before.portals ?? []), ...sites]).slice(-MAX_FEEDBACK);
    const changed = JSON.stringify(prefs) !== JSON.stringify(before);
    await ctx.db.patch(row._id, { preferences: prefs, updatedAt: Date.now() });
    const updated = { ...row, preferences: prefs };

    // Still answering the questions after the resume: move on past whatever they've now answered.
    if (row.stage && SETUP_STAGES.includes(row.stage)) {
      const step = row.stage.startsWith("industry") ? 0 : row.stage.startsWith("location") ? 1 : 2;
      const answered = [newIndustries.length > 0, !!args.location?.trim(), !!args.days];
      if (!answered[step]) return args.reply; // Claude's reply asks the question again in its own words
      if (step === 0 && !answered[1]) return `${args.reply}\n\n${await askLocation(ctx, updated, {})}`;
      if (step <= 1 && !answered[2]) return `${args.reply}\n\n${await askDays(ctx, updated, prefs.location ?? "")}`;
      return `${args.reply}\n\n${await finish(ctx, updated, prefs.days ?? 7)}`;
    }

    // Done with the questions. A question they were asked (job site, "more like this?") is now closed.
    if (row.stage !== "ready") await ctx.db.patch(row._id, { stage: "ready", pendingJob: undefined });
    const ready = { ...updated, stage: "ready" as const };
    if (args.rateJob) {
      const rated = await rateFromList(ctx, ready, args.rateJob.number, args.rateJob.liked);
      if (rated === noListYet || rated === noSuchJob(args.rateJob.number)) return rated;
    }
    if (!args.search && !changed) return args.reply;
    if (!args.search) return `${args.reply}\n\n${savedForNext}`;
    if (isSearching(row)) {
      if (changed) {
        await ctx.db.patch(row._id, { searchQueued: true });
        return `${args.reply}\n\n${searchQueuedText}`;
      }
      return args.reply; // nothing new to search for; their jobs are already on the way
    }
    return `${args.reply}\n\n${await searchNow(ctx, ready)}`;
  },
});

const dedupe = (list: string[]) => list.filter((item, i) => list.findIndex((x) => x.toLowerCase() === item.toLowerCase()) === i);

// Called after explaining a job: ask "want more like this?" if they've finished the questions.
export const askJobFeedback = internalMutation({
  args: { phone: v.string(), job: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone, job }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row || (row.stage !== "ready" && row.stage !== "job_feedback")) return false;
    await ctx.db.patch(row._id, { stage: "job_feedback", pendingJob: job, updatedAt: Date.now() });
    return true;
  },
});

// The first question after a resume: same industry or different (or "which industry" if unknown).
export async function startQuestions(ctx: MutationCtx, row: Doc<"profile">): Promise<string> {
  const stage = row.currentIndustry ? "industry_choice" : "industry_input";
  await ctx.db.patch(row._id, { stage, updatedAt: Date.now() });
  return row.currentIndustry ? industryQuestion(row.currentIndustry) : industryInputQuestion;
}

async function askLocation(ctx: MutationCtx, row: Doc<"profile">, update: { industries?: string[] }) {
  const preferences = { ...row.preferences, ...update };
  const stage = row.currentLocation ? "location_choice" : "location_input";
  await ctx.db.patch(row._id, { preferences, stage, updatedAt: Date.now() });
  return row.currentLocation ? locationQuestion(row.currentLocation) : metroQuestion;
}

async function askDays(ctx: MutationCtx, row: Doc<"profile">, location: string) {
  const preferences = { ...row.preferences, location };
  await ctx.db.patch(row._id, { preferences, stage: "days_choice", updatedAt: Date.now() });
  return daysQuestion;
}

async function finish(ctx: MutationCtx, row: Doc<"profile">, days: number) {
  const preferences = { ...row.preferences, days };
  await ctx.db.patch(row._id, { preferences, stage: "ready", updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.jobs.searchForUser, { phone: row.phone!, announce: false });
  return allSet(preferences.industries ?? [], preferences.location ?? "India", days);
}

const isCommand = (word: string) => /^(change|update|preferences?|jobs?|search|more|again)$/.test(word);

// "3 no", "no 3", "1 yes", "2: y" → which job in the last list, and liked or not.
function parseRating(word: string): { n: number; yes: boolean } | null {
  const m = word.match(/^(\d{1,2})\s*[-:,.]?\s*(yes|no|y|n)$/) ?? word.match(/^(yes|no|y|n)\s*[-:,.]?\s*(\d{1,2})$/);
  if (!m) return null;
  const [num, answer] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  return { n: Number(num), yes: answer.startsWith("y") };
}

async function rateFromList(ctx: MutationCtx, row: Doc<"profile">, n: number, yes: boolean): Promise<string> {
  const phone = row.phone!;
  const recent = await ctx.db
    .query("searches")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .order("desc")
    .take(10);
  const last = recent.find((search) => search.shown?.length);
  if (!last?.shown?.length) return noListYet;
  const jobId = last.shown[n - 1];
  if (!jobId) return noSuchJob(n);
  const seen = await ctx.db
    .query("jobsSeen")
    .withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone).eq("jobId", jobId))
    .order("desc")
    .first();
  if (!seen) return noSuchJob(n);
  const job = `${seen.title} at ${seen.company}`;
  await saveFeedback(ctx, row, job, yes, {});
  return ratedJob(job, yes);
}

// Adds a job to likes (or dislikes), removing it from the other list. Keeps the most recent few.
async function saveFeedback(
  ctx: MutationCtx,
  row: Doc<"profile">,
  job: string,
  yes: boolean,
  extra: Partial<Doc<"profile">>,
) {
  const key = yes ? "likes" : "dislikes";
  const other = yes ? "dislikes" : "likes";
  const preferences = {
    ...row.preferences,
    [key]: [...(row.preferences?.[key] ?? []).filter((j) => j !== job), job].slice(-MAX_FEEDBACK),
    [other]: (row.preferences?.[other] ?? []).filter((j) => j !== job),
  };
  await ctx.db.patch(row._id, { ...extra, preferences, updatedAt: Date.now() });
}

async function addPortals(ctx: MutationCtx, row: Doc<"profile">, sites: string[], extra: Partial<Doc<"profile">>) {
  const portals = dedupe([...(row.preferences?.portals ?? []), ...sites]).slice(-MAX_FEEDBACK);
  await ctx.db.patch(row._id, { ...extra, preferences: { ...row.preferences, portals }, updatedAt: Date.now() });
}

// Called when a search found nothing that fits: ask which other job site they'd like.
export const askPortal = internalMutation({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row || row.stage !== "ready") return false;
    await ctx.db.patch(row._id, { stage: "portal_input", updatedAt: Date.now() });
    return true;
  },
});
