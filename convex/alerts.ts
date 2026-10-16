import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";

// Daily job alerts. Nothing runs on a timer: each user with alerts on has one booked run, at their
// time (India time). That run books the next day's run first, then searches. Changing or stopping
// alerts cancels the booking.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const INDIA_OFFSET_MS = 5.5 * HOUR_MS;
const SPREAD_MS = 15 * 60 * 1000; // users who chose the same hour are spread over its first 15 minutes

// The next time it's `hour`:00 in India, plus a few minutes that depend on the phone number, so
// many users at 9 am don't all ask LinkedIn at the same moment.
function nextRun(hour: number, phone: string, now: number): number {
  const indiaMidnight = Math.floor((now + INDIA_OFFSET_MS) / DAY_MS) * DAY_MS - INDIA_OFFSET_MS;
  let at = indiaMidnight + hour * HOUR_MS;
  if (at <= now) at += DAY_MS;
  const spread = [...phone].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % SPREAD_MS, 0);
  return at + spread;
}

// Cancels the user's booked alert, if any, and books the next one if alerts are on.
export async function bookNextAlert(ctx: MutationCtx, profileId: Id<"profile">): Promise<void> {
  const row = await ctx.db.get(profileId);
  if (!row) return;
  if (row.alertJobId) {
    const booked = await ctx.db.system.get(row.alertJobId);
    if (booked?.state.kind === "pending") await ctx.scheduler.cancel(row.alertJobId);
  }
  const alertJobId =
    row.alertHour !== undefined && row.phone
      ? await ctx.scheduler.runAt(nextRun(row.alertHour, row.phone, Date.now()), internal.alerts.fire, { profileId })
      : undefined;
  await ctx.db.patch(profileId, { alertJobId });
}

// A booked alert: book tomorrow's first (so a failed search never stops the alerts), then search.
export const fire = internalMutation({
  args: { profileId: v.id("profile") },
  returns: v.null(),
  handler: async (ctx, { profileId }) => {
    const row = await ctx.db.get(profileId);
    if (!row?.phone || row.alertHour === undefined) return null;
    await bookNextAlert(ctx, profileId);
    await ctx.scheduler.runAfter(0, internal.jobs.searchForUser, { phone: row.phone, announce: false, alert: true });
    return null;
  },
});

// When the user's next alert is booked for (or null). For tests and checking from the terminal.
export const nextAlertAt = internalQuery({
  args: { phone: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row?.alertJobId) return null;
    const booked = await ctx.db.system.get(row.alertJobId);
    return booked?.state.kind === "pending" ? booked.scheduledTime : null;
  },
});

// Test helper: run a user's alert now, as if their time had come.
export const fireNowForTest = internalMutation({
  args: { phone: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (row) await ctx.scheduler.runAfter(0, internal.alerts.fire, { profileId: row._id });
    return null;
  },
});

// Change one user's alert hour (0-23, India time) from the terminal, and rebook the next run.
export const setHour = internalMutation({
  args: { phone: v.string(), hour: v.number() },
  returns: v.union(v.number(), v.null()), // when the next alert will run
  handler: async (ctx, { phone, hour }) => {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    const row = await ctx.db
      .query("profile")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, { alertHour: hour, alertsAsked: true });
    await bookNextAlert(ctx, row._id);
    const booked = (await ctx.db.get(row._id))?.alertJobId;
    return booked ? ((await ctx.db.system.get(booked))?.scheduledTime ?? null) : null;
  },
});
