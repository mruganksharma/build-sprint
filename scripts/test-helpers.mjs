// Shared pieces for the test scripts. They run against the DEV deployment with made-up data only.
import { execFileSync, execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const site = readFileSync(".env.local", "utf8").match(/^CONVEX_SITE_URL=(.+)$/m)?.[1].trim();
const appSecret = execSync("npx convex env get WHATSAPP_APP_SECRET").toString().trim();

export const run = (fn, args) =>
  JSON.parse(execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)]).toString() || "null");

const base = `1555${Date.now().toString().slice(-6)}`;
let n = 0;
export const newPhone = () => `${base}${n++}`; // made-up number per case

let failed = 0;
export const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
export const finish = () => process.exit(failed ? 1 : 0);

// A made-up person. Nothing here is real.
export const RESUME = `PRIYA NAIR
Senior Product Manager | B2B SaaS | 9 years
Email: priya.nair@example.com | linkedin.com/in/priya-nair-example | Bengaluru, India

EXPERIENCE
Senior Product Manager, Acme Cloud (2021 - present)
- Led the billing and invoicing product for 4,000 mid-market customers; grew revenue 35%.
- Shipped usage-based pricing, cutting churn by 12%.
Product Manager, Example Analytics (2017 - 2021)
- Built a self-serve dashboard used by 20,000 analysts.
- Ran discovery with 60 customers to define the reporting roadmap.
Business Analyst, Sample Consulting (2015 - 2017)

EDUCATION
MBA, Example Business School (2015)
B.E. Computer Science (2013)

SKILLS
Roadmapping, pricing, SQL, customer discovery, A/B testing`;

// Writes the made-up resume as .txt, .docx, .pdf, .html and .png into a temp folder.
export function makeFiles() {
  const dir = mkdtempSync(join(tmpdir(), "resume-test-"));
  const f = (name) => join(dir, name);
  writeFileSync(f("priya.txt"), RESUME);
  execFileSync("textutil", ["-convert", "docx", f("priya.txt"), "-output", f("priya.docx")]);
  execFileSync("textutil", ["-convert", "doc", f("priya.txt"), "-output", f("priya.doc")]);
  // The same resume split in two, as two photos (page 1 and page 2).
  const lines = RESUME.split("\n");
  const half = lines.indexOf("EDUCATION");
  writeFileSync(f("page1.txt"), lines.slice(0, half).join("\n"));
  writeFileSync(f("page2.txt"), lines.slice(half).join("\n"));
  for (const page of ["page1", "page2"]) {
    writeFileSync(f(`${page}.pdf`), execFileSync("cupsfilter", [f(`${page}.txt`)], { stdio: ["ignore", "pipe", "ignore"] }));
    execFileSync("sips", ["-s", "format", "png", f(`${page}.pdf`), "--out", f(`${page}.png`)], { stdio: "ignore" });
  }
  writeFileSync(f("priya.pdf"), execFileSync("cupsfilter", [f("priya.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  writeFileSync(f("priya.html"), `<!doctype html><html><head><title>Priya Nair</title><style>body{font:16px sans-serif}</style></head><body>${RESUME.split("\n").map((l) => `<p>${l.replace(/&/g, "&amp;")}</p>`).join("")}</body></html>`);
  execFileSync("sips", ["-s", "format", "png", f("priya.pdf"), "--out", f("priya.png")], { stdio: "ignore" });
  execFileSync("sips", ["-Z", "60", f("priya.png"), "--out", f("priya-tiny.png")], { stdio: "ignore" });
  writeFileSync(f("big.pdf"), Buffer.alloc(1024 * 1024 + 10, 65)); // just over 1 MB
  return f;
}

// A signed, Meta-shaped webhook message from a made-up number.
export async function sendWhatsApp(phone, msg) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      messages: [{ from: phone, id: `wamid.test-${phone}-${Math.random()}`, timestamp: "0", ...msg }],
    } }] }],
  });
  const res = await fetch(`${site}/whatsapp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex"),
    },
    body,
  });
  if (res.status !== 200) throw new Error(`webhook returned ${res.status}`);
}
export const sendText = (phone, text) => sendWhatsApp(phone, { type: "text", text: { body: text } });

// Puts a file in Convex storage; returns its id.
export async function upload(path, mimeType) {
  const res = await fetch(run("profile:uploadUrl", {}), {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: readFileSync(path),
  });
  return (await res.json()).storageId;
}

// Same as after a WhatsApp download: the file goes to storage, then gets read.
export async function sendFile(phone, path, fileName, mimeType) {
  run("resume:ingestFile", { phone, fileId: await upload(path, mimeType), fileName, mimeType });
}

// Waits for the app's reply to a number (replies are scheduled, so they lag a little).
export async function lastReply(phone) {
  for (let i = 0; i < 45; i++) {
    const out = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out");
    if (out.length) return out.at(-1).text;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// Waits until one of the app's replies to a number matches `want` (or 3 minutes pass); returns it,
// or the newest reply if none matched.
export async function waitForMatch(phone, want) {
  let out = [];
  for (let i = 0; i < 90; i++) {
    out = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);
    const hit = out.find((t) => want.test(t));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return out.at(-1) ?? null;
}

// Runs cases in parallel: each sends something from a fresh number, then checks reply and profile.
export async function runCases(cases) {
  await Promise.all(cases.map(async (c) => {
    c.phone = newPhone();
    await c.send(c.phone);
    c.got = await waitForMatch(c.phone, c.reply);
    c.profile = run("profile:getByPhone", { phone: c.phone });
  }));
  for (const c of cases) {
    const savedOk = c.saved ? !!c.profile && c.profile.resumeTextLength > 200 && (!c.file || c.profile.hasFile) : !c.profile;
    const extraOk = !c.expect || (!!c.profile && c.expect(c.profile, c.phone));
    check(c.name, savedOk && extraOk && !!c.got && c.reply.test(c.got), `reply: ${c.got}`);
  }
}

// Waits until the app has sent `count` replies to a number; returns the newest one.
export async function waitForReplies(phone, count) {
  for (let i = 0; i < 60; i++) {
    const out = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out");
    if (out.length >= count) return out.at(-1).text;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
