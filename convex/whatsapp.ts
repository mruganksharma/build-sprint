import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

// WhatsApp Cloud API: save what users send, and reply.
// Needs these Convex environment variables (set in the Convex dashboard, never in code):
//   WHATSAPP_VERIFY_TOKEN   made-up password Meta sends once to check the webhook
//   WHATSAPP_APP_SECRET     Meta app secret, used to check each message really came from Meta
//   WHATSAPP_TOKEN          permanent access token, for sending replies
//   WHATSAPP_PHONE_ID       the business phone number's id, for sending replies
// Until WHATSAPP_TOKEN and WHATSAPP_PHONE_ID are set, replies are only logged, not sent.
// Test number via the Hermes relay (see http.ts /hermes/*): replies to users whose latest message
// came through Hermes are queued here and collected by the relay instead of going to Meta.

const GRAPH_URL = "https://graph.facebook.com/v23.0";

// Returns false if this WhatsApp message id was already saved (Meta re-sends on slow replies).
export const saveIncoming = internalMutation({
  args: {
    phone: v.string(),
    waMessageId: v.string(),
    type: v.string(),
    text: v.optional(v.string()),
    mediaId: v.optional(v.string()),
    fileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    channel: v.optional(v.literal("hermes")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_waMessageId", (q) => q.eq("waMessageId", args.waMessageId))
      .first();
    if (existing) return false;
    await ctx.db.insert("messages", { ...args, direction: "in" });
    return true;
  },
});

export const saveOutgoing = internalMutation({
  args: {
    phone: v.string(),
    text: v.string(),
    waMessageId: v.optional(v.string()),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("logged_only"), v.literal("queued")),
    channel: v.optional(v.literal("hermes")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", { ...args, direction: "out", type: "text" });
    return null;
  },
});

// Which way the user's latest message came in, so the reply goes back the same way.
export const channelFor = internalQuery({
  args: { phone: v.string() },
  returns: v.union(v.literal("hermes"), v.literal("meta")),
  handler: async (ctx, { phone }) => {
    const latestIn = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .filter((q) => q.eq(q.field("direction"), "in"))
      .first();
    return latestIn?.channel === "hermes" ? "hermes" : "meta";
  },
});

// The Hermes relay collects replies waiting for it. Each is handed out once, oldest first.
export const claimHermesOutbox = internalMutation({
  args: {},
  returns: v.array(v.object({ phone: v.string(), text: v.string() })),
  handler: async (ctx) => {
    const queued = await ctx.db
      .query("messages")
      .withIndex("by_channel_and_status", (q) => q.eq("channel", "hermes").eq("status", "queued"))
      .take(20);
    for (const m of queued) await ctx.db.patch(m._id, { status: "sent" });
    return queued.map((m) => ({ phone: m.phone, text: m.text ?? "" }));
  },
});

// Cancel messages still waiting for the Hermes relay for one number (e.g. stale alerts), so they
// are never delivered. Marked "failed" so the record stays. Run from the terminal.
export const dropQueued = internalMutation({
  args: { phone: v.string() },
  returns: v.number(),
  handler: async (ctx, { phone }) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(200);
    const queued = rows.filter((m) => m.channel === "hermes" && m.status === "queued");
    for (const m of queued) await ctx.db.patch(m._id, { status: "failed" });
    return queued.length;
  },
});

export const sendReply = internalAction({
  args: { to: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { to, text }) => {
    if ((await ctx.runQuery(internal.whatsapp.channelFor, { phone: to })) === "hermes") {
      await ctx.runMutation(internal.whatsapp.saveOutgoing, { phone: to, text, status: "queued", channel: "hermes" });
      return null;
    }
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    // WHATSAPP_SEND=off: dev-only switch the test scripts set, so made-up test numbers are never texted.
    if (!token || !phoneId || process.env.WHATSAPP_SEND === "off") {
      console.log(`[whatsapp] no credentials yet; would send to ${to}: ${text}`);
      await ctx.runMutation(internal.whatsapp.saveOutgoing, { phone: to, text, status: "logged_only" });
      return null;
    }
    const res = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[whatsapp] send failed (${res.status}): ${JSON.stringify(body)}`);
      await ctx.runMutation(internal.whatsapp.saveOutgoing, { phone: to, text, status: "failed" });
      return null;
    }
    await ctx.runMutation(internal.whatsapp.saveOutgoing, {
      phone: to,
      text,
      status: "sent",
      waMessageId: body?.messages?.[0]?.id,
    });
    return null;
  },
});

// The latest messages with one number, oldest first. Run from the terminal:
//   npx convex run whatsapp:messagesForPhone '{"phone": "15550000001"}'
export const messagesForPhone = internalQuery({
  args: { phone: v.string() },
  returns: v.array(
    v.object({
      direction: v.union(v.literal("in"), v.literal("out")),
      type: v.string(),
      text: v.union(v.string(), v.null()),
      fileName: v.union(v.string(), v.null()),
      status: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { phone }) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(50);
    return rows.reverse().map((m) => ({
      direction: m.direction,
      type: m.type,
      text: m.text ?? null,
      fileName: m.fileName ?? null,
      status: m.status ?? null,
    }));
  },
});

// Read-only: Meta's current view of our WhatsApp number (is it connected, live, name approved).
// Sends nothing. Run from the terminal: npx convex run whatsapp:metaStatus
export const metaStatus = internalAction({
  args: {},
  returns: v.any(),
  handler: async () => {
    const fields = "verified_name,display_phone_number,status,account_mode,name_status,code_verification_status,quality_rating,platform_type,messaging_limit_tier";
    const res = await fetch(`${GRAPH_URL}/${process.env.WHATSAPP_PHONE_ID}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown> & { display_phone_number?: string };
    if (body.display_phone_number) body.display_phone_number = `…${String(body.display_phone_number).replace(/\D/g, "").slice(-4)}`;
    return { httpStatus: res.status, ...body };
  },
});

// Test: send Meta's ready-made "hello_world" template (allowed any time, unlike free text) to one
// number, to see whether Meta sending works. Returns Meta's answer. Terminal only.
export const sendHelloWorldTest = internalAction({
  args: { to: v.string() },
  returns: v.any(),
  handler: async (_ctx, { to }) => {
    const res = await fetch(`${GRAPH_URL}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }),
    });
    const body = JSON.stringify(await res.json()).replaceAll(to, `…${to.slice(-4)}`);
    return { httpStatus: res.status, meta: JSON.parse(body) };
  },
});
