// Claude reads messages the app can't handle on its own. Checks what the app DID (saved
// preferences, which question it's on, no repeated replies), not exact words: people phrase the
// same request in many ways, so each kind of request is sent several different ways, typos included.
// Runs against the DEV deployment with a made-up resume. Turns off real job searches for the run
// and puts them back after (test-helpers does the same for WhatsApp sending). About 30 Claude calls.
// Run: npm run test:understand
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const envGet = (name) => {
  try {
    return execSync(`npx convex env get ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
};
const envSet = (name, value) =>
  value === null
    ? execSync(`npx convex env remove ${name}`, { stdio: "ignore" })
    : execSync(`npx convex env set ${name} ${value}`, { stdio: "ignore" });

const SEARCH_RUNNING = /still running\. I'll search again/; // the app's own line, not Claude's words
const lower = (list) => (list ?? []).map((s) => s.toLowerCase());
const hasFintech = (p) => lower(p.preferences?.industries).some((i) => i.includes("fin"));
const hasSaas = (p) => lower(p.preferences?.industries).some((i) => i.includes("saas"));

// Sends messages one at a time; returns every reply the app sent after each one.
async function say(phone, messages) {
  const replies = [];
  for (const text of messages) {
    const before = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").length;
    await sendText(phone, text);
    await waitForReplies(phone, before + 1);
    replies.push(run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").at(-1).text);
  }
  return replies;
}
// A made-up user who has sent a resume and answered the questions (B2B SaaS, Bengaluru, 7 days).
async function readyUser() {
  const phone = newPhone();
  await say(phone, [RESUME, "1", "1", "2"]);
  return phone;
}
const profile = (phone) => run("profile:getByPhone", { phone });
const noRepeats = (replies) => replies.every((r, i) => !!r && (i === 0 || r !== replies[i - 1]));

const tests = [
  ...[
    "I only got one job. Widen the scope to fintech as wel",
    "can u also look at fintech roles",
    "pls include fintech jobs too, not just saas",
  ].map((msg) => ({
    name: `add an industry: "${msg}"`,
    run: async () => {
      const phone = await readyUser();
      const [reply] = await say(phone, [msg]);
      const p = profile(phone);
      return { ok: hasFintech(p) && hasSaas(p), detail: `industries ${p.preferences?.industries} | ${reply}` };
    },
  })),
  ...["Change from B2B SaaS to Fintech", "forget saas, i only want fintech now"].map((msg) => ({
    name: `switch industry: "${msg}"`,
    run: async () => {
      const phone = await readyUser();
      const [reply] = await say(phone, [msg]);
      const p = profile(phone);
      return { ok: hasFintech(p) && !hasSaas(p), detail: `industries ${p.preferences?.industries} | ${reply}` };
    },
  })),
  ...[
    ["show me stuff from the past week n a half", (d) => d >= 8 && d <= 14],
    ["go back a whole month pls", (d) => d === 30],
    ["only the freshest ones, posted today", (d) => d === 1],
  ].map(([msg, ok]) => ({
    name: `change how recent: "${msg}"`,
    run: async () => {
      const phone = await readyUser();
      const [reply] = await say(phone, [msg]);
      const p = profile(phone);
      return { ok: ok(p.preferences?.days), detail: `days ${p.preferences?.days} | ${reply}` };
    },
  })),
  {
    name: "change city in a sentence",
    run: async () => {
      const phone = await readyUser();
      const [reply] = await say(phone, ["actually id rather work out of pune"]);
      const p = profile(phone);
      return { ok: /pune/i.test(p.preferences?.location ?? ""), detail: `location ${p.preferences?.location} | ${reply}` };
    },
  },
  {
    name: "unclear messages get different replies, and nothing is changed",
    run: async () => {
      const phone = await readyUser();
      const before = profile(phone).preferences;
      const replies = await say(phone, ["hmm", "ok?", "No"]);
      const after = profile(phone).preferences;
      return { ok: noRepeats(replies) && JSON.stringify(before) === JSON.stringify(after), detail: replies.join(" || ") };
    },
  },
  {
    name: "while a search runs: a change is saved and acknowledged, and 'jobs' twice isn't answered twice the same",
    run: async () => {
      const phone = await readyUser();
      run("profile:markSearchingForTest", { phone });
      const replies = await say(phone, ["add fintech as well pls", "jobs", "jobs"]);
      const p = profile(phone);
      return {
        ok: hasFintech(p) && SEARCH_RUNNING.test(replies[0]) && noRepeats(replies),
        detail: replies.join(" || "),
      };
    },
  },
  {
    name: "mid-question, a sentence answering two questions moves past both",
    run: async () => {
      const phone = newPhone();
      await say(phone, [RESUME]);
      const [reply] = await say(phone, ["id like fintech jobs in pune please"]);
      const p = profile(phone);
      return {
        ok: hasFintech(p) && /pune/i.test(p.preferences?.location ?? "") && p.stage === "days_choice",
        detail: `stage ${p.stage}, industries ${p.preferences?.industries}, location ${p.preferences?.location} | ${reply}`,
      };
    },
  },
  {
    name: "mid-question, an off-topic message is answered and the question stays open",
    run: async () => {
      const phone = newPhone();
      await say(phone, [RESUME]);
      const replies = await say(phone, ["wait what does this app do", "hmm not sure"]);
      const p = profile(phone);
      return { ok: p.stage === "industry_choice" && noRepeats(replies), detail: replies.join(" || ") };
    },
  },
  {
    name: "no resume yet: a second message isn't met with the same welcome",
    run: async () => {
      const phone = newPhone();
      const replies = await say(phone, ["Hi", "hello??", "what is this"]);
      return { ok: noRepeats(replies) && !profile(phone), detail: replies.join(" || ") };
    },
  },
];

const saved = envGet("JOB_SEARCH");
envSet("JOB_SEARCH", "off");
try {
  const results = await Promise.all(tests.map(async (t) => {
    try {
      return { t, ...(await t.run()) };
    } catch (e) {
      return { t, ok: false, detail: String(e) };
    }
  }));
  for (const { t, ok, detail } of results) check(t.name, ok, detail);
} finally {
  envSet("JOB_SEARCH", saved);
}
finish();
