// Milestone 4 test: after a made-up resume, a made-up user answers the industry and city
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
      ["1", /^All set\. I'll look for .+ jobs in .+\.$/],
    ],
    expect: (p) => p.stage === "ready" && p.preferences.industries[0] === p.currentIndustry && p.preferences.location === p.currentLocation,
  },
  {
    name: "different industries, metro by number",
    steps: [
      [RESUME, /Got your resume/],
      ["2", /Which industry/],
      ["Fintech, Healthcare", /You're based in/],
      ["2", /Which city[\s\S]*3\. Bengaluru/],
      ["6", /^All set\. I'll look for Fintech, Healthcare jobs in Pune\.$/],
    ],
    expect: (p) => p.stage === "ready" && p.preferences.industries.join("|") === "Fintech|Healthcare" && p.preferences.location === "Pune",
  },
  {
    name: "words instead of numbers, city not in the list",
    steps: [
      [RESUME, /Got your resume/],
      ["Different", /Which industry/],
      ["Edtech", /You're based in/],
      ["somewhere else", /Which city/],
      ["Jaipur", /^All set\. I'll look for Edtech jobs in Jaipur\.$/],
    ],
    expect: (p) => p.preferences.location === "Jaipur" && p.preferences.industries[0] === "Edtech",
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
      ["1", /^All set/],
      ["thanks!", /You're all set\. Send a new resume anytime/],
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
