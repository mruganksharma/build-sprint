import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import {
  METROS,
  allSet,
  industryInputQuestion,
  industryQuestion,
  locationQuestion,
  metroQuestion,
  noAngleBrackets,
  pleaseChoose,
  readyHelp,
  searchingAgain,
  stillSearching,
  likedReply,
  dislikedReply,
} from "./chatText";

// Milestone 4: after the resume, ask which industry and which city the user wants, one question
// at a time, and save the answers to their preferences. No AI: answers are numbers or short words.

const MAX_INDUSTRY_CHARS = 100;
const MAX_CITY_CHARS = 60;
const SEARCH_LOCK_MS = 10 * 60 * 1000;
const MAX_FEEDBACK = 10; // most recent likes and dislikes kept per user

// Handles a short text message from a WhatsApp user. Returns the reply, or null if we have no
// resume for them yet (the caller then sends the welcome message).
export const handleAnswer = internalMutation({
  args: { phone: v.string(), text: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { phone, text }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return null;
    const answer = text.trim();
    const word = answer.toLowerCase();
    if (/[<>]/.test(answer)) return noAngleBrackets;

    switch (row.stage) {
      case "industry_choice": {
        const industry = row.currentIndustry ?? "";
        if (word === "1" || word.startsWith("same")) return askLocation(ctx, row, { industries: [industry] });
        if (word === "2" || word.startsWith("diff")) {
          await ctx.db.patch(row._id, { stage: "industry_input", updatedAt: Date.now() });
          return industryInputQuestion;
        }
        return pleaseChoose(industryQuestion(industry));
      }
      case "industry_input": {
        const industries = answer
          .split(/,|\/|\band\b|\n/i)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 3);
        if (!industries.length || answer.length > MAX_INDUSTRY_CHARS) return industryInputQuestion;
        return askLocation(ctx, row, { industries });
      }
      case "location_choice": {
        const current = row.currentLocation ?? "";
        if (word === "1" || word.startsWith("same") || word === current.toLowerCase()) {
          return finish(ctx, row, current);
        }
        if (word === "2" || word.startsWith("somewhere") || word.startsWith("diff") || word.startsWith("else")) {
          await ctx.db.patch(row._id, { stage: "location_input", updatedAt: Date.now() });
          return metroQuestion;
        }
        return pleaseChoose(locationQuestion(current));
      }
      case "location_input": {
        const pick = Number(word);
        if (Number.isInteger(pick) && pick >= 1 && pick <= METROS.length) return finish(ctx, row, METROS[pick - 1]);
        if (!/\p{L}/u.test(answer) || answer.length > MAX_CITY_CHARS) return metroQuestion;
        return finish(ctx, row, answer);
      }
      case "job_feedback": {
        const job = row.pendingJob ?? "";
        const yes = word === "1" || word.startsWith("yes");
        const no = word === "2" || word.startsWith("no");
        if (yes || no) {
          const key = yes ? "likes" : "dislikes";
          const other = yes ? "dislikes" : "likes";
          const preferences = {
            ...row.preferences,
            [key]: [...(row.preferences?.[key] ?? []).filter((j) => j !== job), job].slice(-MAX_FEEDBACK),
            [other]: (row.preferences?.[other] ?? []).filter((j) => j !== job),
          };
          await ctx.db.patch(row._id, { preferences, stage: "ready", pendingJob: undefined, updatedAt: Date.now() });
          return yes ? likedReply : dislikedReply;
        }
        // Anything else: drop the question and treat it as a normal message.
        await ctx.db.patch(row._id, { stage: "ready", pendingJob: undefined, updatedAt: Date.now() });
        return readyAnswer(ctx, { ...row, stage: "ready" }, word);
      }
      default:
        return readyAnswer(ctx, row, word);
    }
  },
});

// After the questions: "change", "jobs", or anything else.
async function readyAnswer(ctx: MutationCtx, row: Doc<"profile">, word: string): Promise<string> {
  if (/^(change|update|preferences?)$/.test(word)) return startQuestions(ctx, row);
  if (/^(jobs?|search|more|again)$/.test(word) && row.stage === "ready") {
    if (row.searchStartedAt && Date.now() - row.searchStartedAt < SEARCH_LOCK_MS) return stillSearching;
    await ctx.scheduler.runAfter(0, internal.jobs.searchForUser, { phone: row.phone!, announce: false });
    return searchingAgain(row.preferences?.industries ?? [], row.preferences?.location ?? "India");
  }
  return readyHelp;
}

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

async function askLocation(ctx: MutationCtx, row: Doc<"profile">, update: { industries: string[] }) {
  const preferences = { ...row.preferences, ...update };
  const stage = row.currentLocation ? "location_choice" : "location_input";
  await ctx.db.patch(row._id, { preferences, stage, updatedAt: Date.now() });
  return row.currentLocation ? locationQuestion(row.currentLocation) : metroQuestion;
}

async function finish(ctx: MutationCtx, row: Doc<"profile">, location: string) {
  const preferences = { ...row.preferences, location };
  await ctx.db.patch(row._id, { preferences, stage: "ready", updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.jobs.searchForUser, { phone: row.phone!, announce: false });
  return allSet(preferences.industries ?? [], location);
}
