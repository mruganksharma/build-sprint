import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { PRIVACY_HTML } from "./privacy";

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

// Every user message arrives here. Check Meta's signature, save, hand it on, and answer 200 fast.
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
        // Delivery reports for our replies: log failures with Meta's reason, so they can be traced.
        for (const status of change.value?.statuses ?? []) {
          if (status.status === "failed") {
            console.warn(`[whatsapp] delivery failed for message ${status.id}: ${JSON.stringify(status.errors ?? [])}`);
          } else {
            console.log(`[whatsapp] message ${status.id} ${status.status}`);
          }
        }
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
            await ctx.scheduler.runAfter(0, internal.resume.handleIncoming, {
              phone: msg.from,
              type: msg.type,
              text: msg.text?.body,
              mediaId: media?.id,
              fileName: msg.document?.filename,
              mimeType: media?.mime_type,
            });
          }
        }
      }
    }
    return new Response("OK", { status: 200 });
  }),
});

// The privacy policy Meta needs before the WhatsApp app can be published.
http.route({
  path: "/privacy",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(PRIVACY_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }),
});

// ---------- Hermes relay: the WhatsApp test number, while Meta's API isn't available ----------
// A Hermes plugin on the owner's laptop forwards messages from the test number here and collects
// the replies. Convex environment variables (never in code):
//   HERMES_RELAY_SECRET     shared secret; the plugin sends it as "Authorization: Bearer <secret>"
//   HERMES_ALLOWED_PHONES   comma-separated numbers allowed to use the test number, e.g. 9198xxxxxxxx

// Someone allowed sends a message to the test number.
http.route({
  path: "/hermes/incoming",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await relayAuthorized(request))) return new Response("Forbidden", { status: 403 });
    let body: { phone?: unknown; messageId?: unknown; type?: unknown; text?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
    const messageId = typeof body.messageId === "string" ? body.messageId.slice(0, 200) : "";
    const type = typeof body.type === "string" ? body.type : "";
    const text = typeof body.text === "string" ? body.text.slice(0, 50000) : undefined;
    if (!phone || !messageId || !type) return new Response("Missing fields", { status: 400 });
    if (!allowedPhones().has(phone)) return new Response("Not allowed", { status: 403 });

    const isNew = await ctx.runMutation(internal.whatsapp.saveIncoming, {
      phone,
      waMessageId: `hermes:${messageId}`,
      type,
      text,
      channel: "hermes",
    });
    if (isNew) {
      if (type === "text") {
        await ctx.scheduler.runAfter(0, internal.resume.handleIncoming, { phone, type, text });
      } else {
        // Files and photos come later; for now only pasted text works on the test number.
        await ctx.scheduler.runAfter(0, internal.whatsapp.sendReply, {
          to: phone,
          text: "For now this test number only reads resumes pasted as text. Please paste your resume here as a message.",
        });
      }
    }
    return Response.json({ ok: true });
  }),
});

// The relay collects replies waiting to be sent on the test number.
http.route({
  path: "/hermes/outbox",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await relayAuthorized(request))) return new Response("Forbidden", { status: 403 });
    const messages = await ctx.runMutation(internal.whatsapp.claimHermesOutbox, {});
    return Response.json({ messages });
  }),
});

function allowedPhones(): Set<string> {
  return new Set(
    (process.env.HERMES_ALLOWED_PHONES ?? "")
      .split(",")
      .map((p) => p.replace(/\D/g, ""))
      .filter(Boolean),
  );
}

async function relayAuthorized(request: Request): Promise<boolean> {
  const secret = process.env.HERMES_RELAY_SECRET;
  const header = request.headers.get("Authorization") ?? "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  // Compare hashes so the check takes the same time whatever was sent.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default http;

type MediaPart = { id: string; mime_type?: string; caption?: string; filename?: string };
type WebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id: string; status: string; errors?: { code: number; title: string; message?: string }[] }[];
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
