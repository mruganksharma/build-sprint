// Sends made-up WhatsApp webhook messages to the DEV deployment and checks what was saved.
// Uses the dev WHATSAPP_VERIFY_TOKEN / WHATSAPP_APP_SECRET (test values, not real Meta secrets).
// Run: npm run test:whatsapp
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const site = readFileSync(".env.local", "utf8").match(/^CONVEX_SITE_URL=(.+)$/m)?.[1].trim();
const env = (name) => execSync(`npx convex env get ${name}`).toString().trim();
const verifyToken = env("WHATSAPP_VERIFY_TOKEN");
const appSecret = env("WHATSAPP_APP_SECRET");
const url = `${site}/whatsapp`;
// Replies to the made-up numbers are saved but never really sent (switched back on at the end).
execSync("npx convex env set WHATSAPP_SEND off", { stdio: "ignore" });
const phone = `1555${Date.now().toString().slice(-7)}`; // made-up number, new each run

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const payload = (msg) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550000000", phone_number_id: "0" },
      contacts: [{ profile: { name: "Test User" }, wa_id: phone }],
      messages: [{ from: phone, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
    } }] }],
  });
const post = (body, secret = appSecret) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });

// 1. Meta's one-time check
let res = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=12345`);
check("verify: right token echoes challenge", res.status === 200 && (await res.text()) === "12345");
res = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
check("verify: wrong token refused", res.status === 403, `got ${res.status}`);

// 2. Messages
const text = payload({ id: `wamid.test-text-${phone}`, type: "text", text: { body: "Hi, I need a job" } });
res = await post(text, "not-the-secret");
check("fake signature refused", res.status === 401, `got ${res.status}`);
res = await post(text);
check("text message accepted", res.status === 200, `got ${res.status}`);
res = await post(text);
check("repeat of same message accepted (and should be ignored)", res.status === 200, `got ${res.status}`);
res = await post(payload({
  id: `wamid.test-doc-${phone}`,
  type: "document",
  document: { id: "1234567890", filename: "resume.pdf", mime_type: "application/pdf" },
}));
check("resume file accepted", res.status === 200, `got ${res.status}`);

// 3. What got saved (replies are scheduled, so give them a moment)
await new Promise((r) => setTimeout(r, 4000));
const rows = JSON.parse(execSync(`npx convex run whatsapp:messagesForPhone '{"phone":"${phone}"}'`).toString());
const incoming = rows.filter((m) => m.direction === "in");
const outgoing = rows.filter((m) => m.direction === "out");
check("2 incoming saved, repeat ignored", incoming.length === 2, `got ${incoming.length}`);
check("text saved", incoming.some((m) => m.type === "text" && m.text === "Hi, I need a job"));
check("file saved with its name", incoming.some((m) => m.type === "document" && m.fileName === "resume.pdf"));
check("1 reply per new message, logged (no Meta token yet)",
  outgoing.length === 2 && outgoing.every((m) => m.status === "logged_only"), `got ${outgoing.length}`);

console.log(`\nTest number: ${phone}`);
console.log(JSON.stringify(rows, null, 2));
execSync("npx convex env remove WHATSAPP_SEND", { stdio: "ignore" });
process.exit(failed ? 1 : 0);
