// Checks the Hermes relay routes (/hermes/incoming, /hermes/outbox) on the DEV deployment with a
// made-up phone number. The number is added to HERMES_ALLOWED_PHONES for the run and removed after.
// Stop the Hermes "jobs" gateway first: this test collects the outbox, so it would take its replies.
// Run: npm run test:hermes
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const site = readFileSync(".env.local", "utf8").match(/^CONVEX_SITE_URL=(.+)$/m)?.[1].trim();
const envGet = (name) => execSync(`npx convex env get ${name}`).toString().trim();
const envSet = (name, value) => execSync(`npx convex env set ${name} '${value}'`, { stdio: "ignore" });
const secret = envGet("HERMES_RELAY_SECRET");
const phone = `1555${Date.now().toString().slice(-7)}`; // made-up number, new each run

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const post = (path, body, key = secret) =>
  fetch(`${site}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body ?? {}),
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Collect replies for our test number until `want` arrive or time runs out.
async function repliesFor(want, timeoutMs) {
  const got = [];
  const end = Date.now() + timeoutMs;
  while (got.length < want && Date.now() < end) {
    const res = await post("/hermes/outbox");
    const { messages } = await res.json();
    got.push(...messages.filter((m) => m.phone === phone).map((m) => m.text));
    if (got.length < want) await sleep(2000);
  }
  return got;
}

const RESUME = `Asha Verma
Mumbai, India | asha.verma@example.com | linkedin.com/in/asha-verma-example
Senior Product Manager with 9 years in B2B SaaS and payments.
Experience
2020-now  Senior Product Manager, ExamplePay (B2B payments platform). Led merchant onboarding and risk checks; cut onboarding time 40%.
2016-2020 Product Manager, SampleSoft (B2B SaaS, workflow tools). Launched reporting module used by 2,000 businesses.
Education
B.Tech, Computer Science, Example Institute of Technology, 2015
Skills: roadmap planning, user research, SQL, API products, stakeholder management.`;

const before = envGet("HERMES_ALLOWED_PHONES");
try {
  // 1. Who may call
  let res = await post("/hermes/incoming", { phone, messageId: "x", type: "text", text: "hi" }, "wrong-secret");
  check("wrong secret refused", res.status === 403, `got ${res.status}`);
  res = await post("/hermes/outbox", {}, "wrong-secret");
  check("outbox: wrong secret refused", res.status === 403, `got ${res.status}`);
  res = await post("/hermes/incoming", { phone, messageId: `t1-${phone}`, type: "text", text: "hi" });
  check("number not on the allowed list refused", res.status === 403, `got ${res.status}`);

  envSet("HERMES_ALLOWED_PHONES", [before, phone].filter(Boolean).join(","));

  // 2. Hello → welcome, and a repeat of the same message is ignored
  res = await post("/hermes/incoming", { phone, messageId: `t2-${phone}`, type: "text", text: "Hi" });
  check("hello accepted", res.status === 200, `got ${res.status}`);
  res = await post("/hermes/incoming", { phone, messageId: `t2-${phone}`, type: "text", text: "Hi" });
  check("repeat accepted (and should be ignored)", res.status === 200, `got ${res.status}`);
  let replies = await repliesFor(1, 20000);
  check("welcome reply queued for the relay", replies.length === 1 && /Send me your resume/.test(replies[0]), JSON.stringify(replies));
  await sleep(3000);
  replies = await repliesFor(1, 3000);
  check("repeat got no second reply", replies.length === 0, JSON.stringify(replies));

  // 3. A file → asked to paste text for now
  res = await post("/hermes/incoming", { phone, messageId: `t3-${phone}`, type: "document" });
  replies = await repliesFor(1, 20000);
  check("file → 'paste as text' reply", replies.length === 1 && /pasted as text/.test(replies[0]), JSON.stringify(replies));

  // 4. Pasted resume → saved, then the industry question
  res = await post("/hermes/incoming", { phone, messageId: `t4-${phone}`, type: "text", text: RESUME });
  replies = await repliesFor(1, 90000);
  check("pasted resume → 'Got your resume' + a question", replies.length === 1 && /Got your resume/.test(replies[0]), JSON.stringify(replies));
} finally {
  envSet("HERMES_ALLOWED_PHONES", before);
  console.log(`\nTest number: ${phone} (removed from HERMES_ALLOWED_PHONES)`);
}
process.exit(failed ? 1 : 0);
