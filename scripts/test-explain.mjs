// Milestone 4b test: made-up users ask "why didn't you show me this job?" by sending LinkedIn job
// links, then say whether they want more like it. Needs JOB_SEARCH=off on dev. A few Claude calls.
// Run: npm run test:explain
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

// A real, current job id from LinkedIn's public search, for the "never seen it" case.
const html = await (await fetch("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Product%20Manager&location=Bengaluru%2C%20Karnataka%2C%20India&f_TPR=r604800", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" } })).text();
const liveJobId = html.match(/urn:li:jobPosting:(\d+)/)?.[1];
if (!liveJobId) throw new Error("couldn't get a live LinkedIn job id for the test");

// Made-up search history: one job we showed, one we left out for breaking a preference.
const seed = (phone) =>
  run("history:saveSearch", {
    phone,
    search: '"Senior Product Manager" in Bengaluru (test)',
    summary: "test",
    jobs: [
      { jobId: "9000000001", title: "Senior Product Manager", company: "Example Cloud", location: "Bengaluru", postedOn: "2026-10-08", url: "https://www.linkedin.com/jobs/view/9000000001", outcome: "shown", fit: "strong", reason: "Billing and pricing SaaS experience matches." },
      { jobId: "9000000002", title: "Product Manager, Lending", company: "Sample Bank", location: "Bengaluru", postedOn: "2026-10-08", url: "https://www.linkedin.com/jobs/view/9000000002", outcome: "broke_preference", fit: "not_a_fit", reason: "Bank lending product.", brokenPreference: "avoid banks: this is a bank" },
    ],
  });

// Gets a made-up user through the resume and both questions (no search runs: JOB_SEARCH=off).
async function readyUser() {
  const phone = newPhone();
  await sendText(phone, RESUME);
  await waitForReplies(phone, 1);
  await sendText(phone, "1");
  await waitForReplies(phone, 2);
  await sendText(phone, "1");
  await waitForReplies(phone, 3);
  seed(phone);
  return phone;
}
async function step(phone, n, text) {
  await sendText(phone, text);
  return (await waitForReplies(phone, n)) ?? "";
}

const cases = [
  async () => {
    const phone = await readyUser();
    const a = await step(phone, 4, "Why didn't you show me more like this? https://www.linkedin.com/jobs/view/9000000001");
    const b = await step(phone, 5, "1");
    const p = run("profile:getByPhone", { phone });
    check("job we showed: says when and why, then 'yes' is saved as a like",
      /^I sent you this one on .*Strong fit\.\nWhy: Billing/.test(a) && /more jobs like this one\?\n1\. Yes/.test(a) && /look out for more/.test(b) &&
      p.preferences.likes?.includes("Senior Product Manager at Example Cloud") && p.stage === "ready", `${a} → ${b}`);
  },
  async () => {
    const phone = await readyUser();
    const a = await step(phone, 4, "https://in.linkedin.com/jobs/view/product-manager-lending-at-sample-bank-9000000002?trk=abc");
    const b = await step(phone, 5, "no");
    const p = run("profile:getByPhone", { phone });
    check("job left out for a preference: names the rule, then 'no' is saved as a dislike",
      /outside what you asked for: avoid banks/.test(a) && /fewer jobs like/.test(b) && p.preferences.dislikes?.includes("Product Manager, Lending at Sample Bank"), `${a} → ${b}`);
  },
  async () => {
    const phone = await readyUser();
    const a = await step(phone, 4, `https://www.linkedin.com/jobs/search/?currentJobId=${liveJobId}&keywords=pm`);
    const b = await step(phone, 5, "jobs");
    const p = run("profile:getByPhone", { phone });
    check("job never seen: says so, judges it now, and 'jobs' skips the question",
      /^That job didn't come up in my searches\.\n\nHere's how .+ fits you: (Strong fit|Partial fit|Not a fit)\.\nWhy: /.test(a) && /more jobs like this one/.test(a) &&
      /^Searching LinkedIn/.test(b) && p.stage === "ready" && !p.preferences.likes && !p.preferences.dislikes, `${a.slice(0, 160)}… → ${b}`);
  },
  async () => {
    const phone = newPhone();
    await sendText(phone, RESUME);
    await waitForReplies(phone, 1);
    seed(phone);
    const a = await step(phone, 2, "https://www.linkedin.com/jobs/view/9000000001");
    const p = run("profile:getByPhone", { phone });
    check("mid-questions: explains but doesn't ask, stays on the question", /^I sent you this one/.test(a) && !/more jobs like this/.test(a) && p.stage === "industry_choice", a);
  },
  async () => {
    const phone = newPhone();
    const a = await step(phone, 1, "https://www.linkedin.com/jobs/view/9000000001");
    check("no resume yet: asks for the resume first", /^Send me your resume first/.test(a), a);
  },
];
await Promise.all(cases.map((c) => c()));
finish();
