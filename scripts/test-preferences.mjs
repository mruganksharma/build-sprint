// Milestone 4 test (needs JOB_SEARCH=off on dev, so finishing doesn't start a real search):
// after a made-up resume, a made-up user answers the industry and city
// questions in different ways. Runs against the DEV deployment; one Claude call per conversation.
// Run: npm run test:preferences
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

// Each conversation: what the user sends, and what the app's reply must match.
const conversations = [
  {
    name: "same industry, same city",
    steps: [
      [RESUME, /Got your resume[\s\S]*1\. Same/],
      ["1", /You're based in[\s\S]*2\. Somewhere else/],
      ["1", /^How recent should the jobs be\?\n1\. Last 24 hours/],
      ["2", /^All set\. Searching LinkedIn for .+ jobs in .+ from the last 7 days now\./],
    ],
    expect: (p) => p.stage === "ready" && p.preferences.industries[0] === p.currentIndustry && p.preferences.location === p.currentLocation && p.preferences.days === 7,
  },
  {
    name: "different industries, metro by number",
    steps: [
      [RESUME, /Got your resume/],
      ["2", /Which industry/],
      ["Fintech, Healthcare", /You're based in/],
      ["2", /Which city[\s\S]*3\. Bengaluru/],
      ["6", /How recent/],
      ["1", /^All set\. Searching LinkedIn for Fintech, Healthcare jobs in Pune from the last 24 hours now\./],
    ],
    expect: (p) => p.stage === "ready" && p.preferences.industries.join("|") === "Fintech|Healthcare" && p.preferences.location === "Pune" && p.preferences.days === 1,
  },
  {
    name: "words instead of numbers, city not in the list",
    steps: [
      [RESUME, /Got your resume/],
      ["Different", /Which industry/],
      ["Edtech", /You're based in/],
      ["somewhere else", /Which city/],
      ["Jaipur", /How recent/],
      ["soon", /^Please reply 1, 2 or 3\./],
      ["last 30 days", /^All set\. Searching LinkedIn for Edtech jobs in Jaipur from the last 30 days now\./],
    ],
    expect: (p) => p.preferences.location === "Jaipur" && p.preferences.industries[0] === "Edtech" && p.preferences.days === 30,
  },
  {
    name: "unclear answer asks again, stays on the same question",
    steps: [
      [RESUME, /Got your resume/],
      ["maybe", /^Please reply 1 or 2\.[\s\S]*1\. Same/],
      ["2", /Which industry/],
      ["<b>Fintech</b>", /without the < and >/],
      ["Fintech", /You're based in/],
    ],
    expect: (p) => p.stage === "location_choice" && p.preferences.industries[0] === "Fintech",
  },
  {
    name: "after finishing, 'change' starts the questions again",
    steps: [
      [RESUME, /Got your resume/],
      ["1", /You're based in/],
      ["1", /How recent/],
      ["2", /^All set/],
      ["thanks!", /^Reply 'jobs' to search for jobs/],
      ["3 no", /^I haven't sent you a list of jobs yet/],
      ["change", /1\. Same/],
    ],
    expect: (p) => p.stage === "industry_choice",
  },
];

await Promise.all(conversations.map(async (c) => {
  const phone = newPhone();
  c.log = [];
  for (const [i, [send, want]] of c.steps.entries()) {
    await sendText(phone, send);
    const got = await waitForReplies(phone, i + 1);
    c.log.push({ send: send.length > 40 ? send.slice(0, 40) + "…" : send, got, ok: !!got && want.test(got) });
    if (!got || !want.test(got)) break;
  }
  c.profile = run("profile:getByPhone", { phone });
}));
for (const c of conversations) {
  const stepsOk = c.log.length === c.steps.length && c.log.every((s) => s.ok);
  const savedOk = !!c.profile && c.expect(c.profile);
  check(c.name, stepsOk && savedOk, stepsOk ? `saved: ${JSON.stringify(c.profile?.preferences)}` : "");
  if (!stepsOk || !savedOk) for (const s of c.log) console.log(`      ${s.ok ? "ok " : "BAD"} sent "${s.send}" → ${JSON.stringify(s.got)}`);
}
finish();
