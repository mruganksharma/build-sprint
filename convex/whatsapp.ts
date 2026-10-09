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
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("logged_only")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", { ...args, direction: "out", type: "text" });
    return null;
  },
});

export const sendReply = internalAction({
  args: { to: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { to, text }) => {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
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
