// Milestone 2 test: made-up resumes sent the ways a WhatsApp user would, against the DEV deployment.
// Every person, number and resume here is invented. Makes a few real Claude calls.
// Run: npm run test:resume
import { execFileSync, execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const site = readFileSync(".env.local", "utf8").match(/^CONVEX_SITE_URL=(.+)$/m)?.[1].trim();
const appSecret = execSync("npx convex env get WHATSAPP_APP_SECRET").toString().trim();
const run = (fn, args) => JSON.parse(execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)]).toString() || "null");
const base = `1555${Date.now().toString().slice(-6)}`;
let n = 0;
const newPhone = () => `${base}${n++}`; // made-up number per case

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

// ---- made-up files ----
const RESUME = `PRIYA NAIR
Senior Product Manager | B2B SaaS | 9 years
Email: priya.nair@example.com | Bengaluru, India

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
const RECIPE = `Grandma's lemon cake. Ingredients: 200 g butter, 200 g sugar, 4 eggs, 200 g flour, 2 lemons, a pinch of salt.
Method: cream the butter and sugar until pale. Beat in the eggs one at a time. Fold in the flour, salt and lemon zest.
Bake at 180 C for 45 minutes. Mix the lemon juice with icing sugar and pour over the warm cake. Leave to cool before slicing.
Serves eight. Keeps for three days in a tin.`;

const dir = mkdtempSync(join(tmpdir(), "resume-test-"));
writeFileSync(join(dir, "priya.txt"), RESUME);
execFileSync("textutil", ["-convert", "docx", join(dir, "priya.txt"), "-output", join(dir, "priya.docx")]);
writeFileSync(join(dir, "priya.pdf"), execFileSync("cupsfilter", [join(dir, "priya.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
writeFileSync(join(dir, "big.pdf"), Buffer.alloc(1024 * 1024 + 10, 65)); // just over 1 MB

// ---- ways in ----
async function sendWhatsApp(phone, msg) {
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
async function sendFile(phone, path, fileName, mimeType) {
  // Same as after a WhatsApp download: the file goes to Convex storage, then gets read.
  const res = await fetch(run("profile:uploadUrl", {}), {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: readFileSync(path),
  });
  const { storageId } = await res.json();
  run("resume:ingestFile", { phone, fileId: storageId, fileName, mimeType });
}
async function lastReply(phone) {
  for (let i = 0; i < 45; i++) {
    const out = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out");
    if (out.length) return out.at(-1).text;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// ---- cases ----
const cases = [
  { name: "pasted resume text is saved", send: (p) => sendWhatsApp(p, { type: "text", text: { body: RESUME } }), saved: true, reply: /^Got your resume: .*Product Manager/i },
  { name: "PDF resume is saved", send: (p) => sendFile(p, join(dir, "priya.pdf"), "priya.pdf", "application/pdf"), saved: true, file: true, reply: /^Got your resume: .*Product Manager/i },
  { name: "Word resume is saved", send: (p) => sendFile(p, join(dir, "priya.docx"), "priya.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), saved: true, file: true, reply: /^Got your resume: .*Product Manager/i },
  { name: ".txt resume is saved", send: (p) => sendFile(p, join(dir, "priya.txt"), "priya.txt", "text/plain"), saved: true, file: true, reply: /^Got your resume: .*Product Manager/i },
  { name: "short hello gets the welcome", send: (p) => sendWhatsApp(p, { type: "text", text: { body: "Hi" } }), saved: false, reply: /^Hi! Send me your resume/ },
  { name: "text with < > is refused", send: (p) => sendWhatsApp(p, { type: "text", text: { body: RESUME + "\n<script>alert(1)</script>" } }), saved: false, reply: /without the < and >/ },
  { name: "pasted recipe is not a resume", send: (p) => sendWhatsApp(p, { type: "text", text: { body: RECIPE } }), saved: false, reply: /doesn't look like a resume/ },
  { name: "Excel file is refused", send: (p) => sendWhatsApp(p, { type: "document", document: { id: "111", filename: "cv.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }), saved: false, reply: /can't read that kind of file/ },
  { name: "photo gets 'not yet'", send: (p) => sendWhatsApp(p, { type: "image", image: { id: "222", mime_type: "image/jpeg" } }), saved: false, reply: /can't read photos yet/ },
  { name: "file over 1 MB is refused", send: (p) => sendFile(p, join(dir, "big.pdf"), "big.pdf", "application/pdf"), saved: false, reply: /over 1 MB/ },
];

await Promise.all(cases.map(async (c) => {
  c.phone = newPhone();
  await c.send(c.phone);
  c.got = await lastReply(c.phone);
  c.profile = run("profile:getByPhone", { phone: c.phone });
}));
for (const c of cases) {
  const savedOk = c.saved ? !!c.profile && c.profile.resumeTextLength > 200 && (!c.file || c.profile.hasFile) : !c.profile;
  check(c.name, savedOk && !!c.got && c.reply.test(c.got), `reply: ${c.got}`);
}
process.exit(failed ? 1 : 0);
