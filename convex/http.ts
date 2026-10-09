import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// Meta checks the webhook once: echo back hub.challenge if the verify token matches.
http.route({
  path: "/whatsapp",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const params = new URL(request.url).searchParams;
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (
      expected &&
      params.get("hub.mode") === "subscribe" &&
      params.get("hub.verify_token") === expected
    ) {
      return new Response(params.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }),
});

// Every user message arrives here. Check Meta's signature, save, reply, and answer 200 fast.
http.route({
  path: "/whatsapp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret || !(await signatureMatches(raw, request.headers.get("X-Hub-Signature-256"), secret))) {
      return new Response("Bad signature", { status: 401 });
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Delivery/read receipts come without "messages"; nothing to do for those yet.
        for (const msg of change.value?.messages ?? []) {
          const media = msg.document ?? msg.image;
          const isNew = await ctx.runMutation(internal.whatsapp.saveIncoming, {
            phone: msg.from,
            waMessageId: msg.id,
            type: msg.type,
            text: msg.text?.body ?? media?.caption,
            mediaId: media?.id,
            fileName: msg.document?.filename,
            mimeType: media?.mime_type,
          });
          if (isNew) {
            await ctx.scheduler.runAfter(0, internal.whatsapp.sendReply, {
              to: msg.from,
              text: "Got it. I'm still being built, I'll have jobs for you soon.",
            });
          }
        }
      }
    }
    return new Response("OK", { status: 200 });
  }),
});

export default http;

type MediaPart = { id: string; mime_type?: string; caption?: string; filename?: string };
type WebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        messages?: {
          from: string;
          id: string;
          type: string;
          text?: { body: string };
          document?: MediaPart;
          image?: MediaPart;
        }[];
      };
    }[];
  }[];
};

// X-Hub-Signature-256 is "sha256=" + hex HMAC-SHA256 of the raw body, keyed with the app secret.
async function signatureMatches(body: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
