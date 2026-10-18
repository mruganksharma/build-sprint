import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { joinFull, spotOpened } from "./chatText";

// Guests: people who joined the Hermes number by sending the joining phrase (the pre-typed text of
// the shared wa.me link). The owner and testers are on HERMES_ALLOWED_PHONES instead and don't
// count. At most MAX_GUESTS at a time; after that, people wait in line and get in, oldest first,
// when a guest leaves ("delete my data" or a terminal erase).

export const MAX_GUESTS = 20;
export const JOIN_PHRASE = "Hi, I want you to find me jobs";

// Case, punctuation and extra spaces don't matter; the words must be exactly the phrase.
const words = (text: string) => text.toLowerCase().replace(/[^a-z]+/g, " ").trim();
export const isJoinPhrase = (text: string) => words(text) === words(JOIN_PHRASE);

// Someone not on the list sent the joining phrase. "joined": now a guest. "guest": already one.
// "full": no room, so they're in line (reply is the message to send them).
export const join = internalMutation({
  args: { phone: v.string() },
  returns: v.object({
    status: v.union(v.literal("joined"), v.literal("guest"), v.literal("full")),
    reply: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("guests")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (row?.status === "guest") return { status: "guest" as const, reply: null };
    const guests = await ctx.db
      .query("guests")
      .withIndex("by_status_and_addedAt", (q) => q.eq("status", "guest"))
      .take(MAX_GUESTS);
    if (guests.length >= MAX_GUESTS) {
      if (!row) await ctx.db.insert("guests", { phone, status: "waiting", addedAt: Date.now() });
      return { status: "full" as const, reply: joinFull };
    }
    if (row) await ctx.db.patch(row._id, { status: "guest", addedAt: Date.now() });
    else await ctx.db.insert("guests", { phone, status: "guest", addedAt: Date.now() });
    return { status: "joined" as const, reply: null };
  },
});

export const isGuest = internalQuery({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) => {
    const row = await ctx.db
      .query("guests")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    return row?.status === "guest";
  },
});

// Every guest's number, for the relay: it only ever sends to numbers on its list or this one.
export const guestPhones = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("guests")
      .withIndex("by_status_and_addedAt", (q) => q.eq("status", "guest"))
      .take(MAX_GUESTS * 2);
    return rows.map((r) => r.phone);
  },
});

// Takes someone off the list (or out of the line). If a guest left, the person waiting longest
// gets their spot and a message saying so. Called by erase.ts.
export async function removeGuest(ctx: MutationCtx, phone: string): Promise<void> {
  const row = await ctx.db
    .query("guests")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (!row) return;
  await ctx.db.delete(row._id);
  if (row.status !== "guest") return;
  const next = await ctx.db
    .query("guests")
    .withIndex("by_status_and_addedAt", (q) => q.eq("status", "waiting"))
    .first();
  if (!next) return;
  await ctx.db.patch(next._id, { status: "guest", addedAt: Date.now() });
  await ctx.db.insert("messages", { phone: next.phone, direction: "out", type: "text", text: spotOpened, status: "queued", channel: "hermes" });
}

// Terminal: who's in and who's waiting, last 4 digits only.
//   npx convex run guests:list
export const list = internalQuery({
  args: {},
  returns: v.object({ guests: v.array(v.string()), waiting: v.array(v.string()), max: v.number() }),
  handler: async (ctx) => {
    const take = (status: "guest" | "waiting") =>
      ctx.db
        .query("guests")
        .withIndex("by_status_and_addedAt", (q) => q.eq("status", status))
        .take(200);
    const mask = (rows: { phone: string }[]) => rows.map((r) => `…${r.phone.slice(-4)}`);
    return { guests: mask(await take("guest")), waiting: mask(await take("waiting")), max: MAX_GUESTS };
  },
});
