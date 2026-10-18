import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { removeGuest } from "./guests";

// Erase everything stored for one WhatsApp number, so a tester can start again as a new user:
// profile (resume text, original file and photos, preferences, booked daily alert), messages,
// searches, jobs looked at, waiting photos and dashboard scores. Run from the terminal only:
//   npx convex run erase:eraseUser '{"phone": "91XXXXXXXXXX"}'
// They also leave the guest list (if they joined with the phrase), freeing their spot.
// Shared, non-personal data (company lists, company job boards) is kept.

const BATCH = 200;

export const eraseUser = internalAction({
  // keepGuest: "delete my data" keeps them on the guest list until the "Done" reply has gone out
  // (dropGoodbye removes them); otherwise the relay would refuse to send it.
  args: { phone: v.string(), keepGuest: v.optional(v.boolean()) },
  returns: v.object({ erased: v.boolean(), searching: v.boolean(), note: v.string(), rows: v.record(v.string(), v.number()) }),
  handler: async (ctx, { phone, keepGuest }) => {
    const masked = `…${phone.slice(-4)}`;
    const rows: Record<string, number> = {};
    for (;;) {
      const step = await ctx.runMutation(internal.erase.eraseBatch, { phone, keepGuest });
      if (step.searching) return { erased: false, searching: true, note: `${masked} has a job search running. Try again in 2 minutes.`, rows };
      for (const [table, n] of Object.entries(step.deleted)) rows[table] = (rows[table] ?? 0) + n;
      if (step.done) break;
    }
    const total = Object.values(rows).reduce((a, b) => a + b, 0);
    return { erased: total > 0, searching: false, note: total ? `Erased everything for ${masked}.` : `Nothing stored for ${masked}.`, rows };
  },
});

// Deletes up to BATCH rows per table for this number. done = nothing left.
export const eraseBatch = internalMutation({
  args: { phone: v.string(), keepGuest: v.optional(v.boolean()) },
  returns: v.object({ searching: v.boolean(), done: v.boolean(), deleted: v.record(v.string(), v.number()) }),
  handler: async (ctx, { phone, keepGuest }) => {
    const deleted: Record<string, number> = {};
    let full = false;

    const profile = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (profile) {
      // A search running now would save its results after the erase; wait for it instead.
      if (profile.searchStartedAt && Date.now() - profile.searchStartedAt < 10 * 60 * 1000) {
        return { searching: true, done: false, deleted };
      }
      for (const fileId of [profile.resumeFileId, ...(profile.resumeExtraFileIds ?? [])]) {
        if (fileId && (await ctx.db.system.get(fileId))) await ctx.storage.delete(fileId);
      }
      if (profile.alertJobId) {
        const job = await ctx.db.system.get(profile.alertJobId);
        if (job?.state.kind === "pending") await ctx.scheduler.cancel(profile.alertJobId);
      }
      await ctx.db.delete(profile._id);
      deleted.profile = 1;
    }

    const photos = await ctx.db.query("pendingPhotos").withIndex("by_phone", (q) => q.eq("phone", phone)).take(BATCH);
    for (const row of photos) {
      if (await ctx.db.system.get(row.fileId)) await ctx.storage.delete(row.fileId);
      await ctx.db.delete(row._id);
    }
    deleted.pendingPhotos = photos.length;
    full ||= photos.length === BATCH;

    const messages = await ctx.db.query("messages").withIndex("by_phone", (q) => q.eq("phone", phone)).take(BATCH);
    for (const row of messages) await ctx.db.delete(row._id);
    deleted.messages = messages.length;
    full ||= messages.length === BATCH;

    const jobs = await ctx.db.query("jobsSeen").withIndex("by_phone_and_jobId", (q) => q.eq("phone", phone)).take(BATCH);
    for (const row of jobs) await ctx.db.delete(row._id);
    deleted.jobsSeen = jobs.length;
    full ||= jobs.length === BATCH;

    const searches = await ctx.db.query("searches").withIndex("by_phone", (q) => q.eq("phone", phone)).take(BATCH);
    for (const row of searches) await ctx.db.delete(row._id);
    deleted.searches = searches.length;
    full ||= searches.length === BATCH;

    const evals = await ctx.db.query("evals").withIndex("by_phone", (q) => q.eq("phone", phone)).take(BATCH);
    for (const row of evals) await ctx.db.delete(row._id);
    deleted.evals = evals.length;
    full ||= evals.length === BATCH;

    if (!full && !keepGuest) await removeGuest(ctx, phone);
    return { searching: false, done: !full, deleted };
  },
});

// ---------- Made-up test users ----------

// Test scripts use made-up numbers starting with 1555 (real numbers start with a country code like
// 91). Erases every one of them, the same way as eraseUser. Run: npx convex run erase:eraseTestUsers
const TEST_PREFIX = "1555";
const MAX_TEST_USERS = 1000;

export const eraseTestUsers = internalAction({
  args: {},
  returns: v.object({ users: v.number(), rows: v.number(), skipped: v.array(v.string()) }),
  handler: async (ctx) => {
    let users = 0;
    let rows = 0;
    const skipped: string[] = [];
    for (let i = 0; i < MAX_TEST_USERS; i++) {
      const phone = await ctx.runQuery(internal.erase.nextTestPhone, { skip: skipped });
      if (!phone) break;
      let total = 0;
      for (;;) {
        const step = await ctx.runMutation(internal.erase.eraseBatch, { phone });
        if (step.searching) {
          skipped.push(phone);
          break;
        }
        total += Object.values(step.deleted).reduce((a, b) => a + b, 0);
        if (step.done) break;
      }
      if (!skipped.includes(phone)) {
        users++;
        rows += total;
      }
    }
    return { users, rows, skipped };
  },
});

// Any made-up test number still in the data (other than ones to skip), or null.
export const nextTestPhone = internalQuery({
  args: { skip: v.array(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { skip }) => {
    const range = { from: TEST_PREFIX, to: `${TEST_PREFIX}\uffff` };
    const pick = (rows: { phone?: string }[]) => rows.map((r) => r.phone).find((p): p is string => !!p && !skip.includes(p)) ?? null;
    const take = skip.length + 1;
    return (
      pick(await ctx.db.query("profile").withIndex("by_phone", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take)) ??
      pick(await ctx.db.query("messages").withIndex("by_phone", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take * 50)) ??
      pick(await ctx.db.query("searches").withIndex("by_phone", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take * 10)) ??
      pick(await ctx.db.query("evals").withIndex("by_phone", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take * 10)) ??
      pick(await ctx.db.query("jobsSeen").withIndex("by_phone_and_jobId", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take * 50)) ??
      pick(await ctx.db.query("pendingPhotos").withIndex("by_phone", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take)) ??
      pick(await ctx.db.query("guests").withIndex("by_phone", (q) => q.gte("phone", range.from).lt("phone", range.to)).take(take))
    );
  },
});

// After "delete my data": the "Done" message is the only record left. Once the relay has collected
// it (or it was sent another way), delete it too, and take them off the guest list. Checks again
// later if it's still waiting.
export const dropGoodbye = internalMutation({
  args: { phone: v.string(), text: v.string(), tries: v.number() },
  returns: v.null(),
  handler: async (ctx, { phone, text, tries }) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(50);
    const goodbye = rows.filter((m) => m.direction === "out" && m.text === text);
    if (goodbye.some((m) => m.status === "queued") && tries < 12) {
      await ctx.scheduler.runAfter(10 * 60 * 1000, internal.erase.dropGoodbye, { phone, text, tries: tries + 1 });
      return null;
    }
    for (const m of goodbye) await ctx.db.delete(m._id);
    await removeGuest(ctx, phone);
    return null;
  },
});
