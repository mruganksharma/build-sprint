// Observability: every output is logged with input, output and a rubric score. Document Read is
// graded by a separate Claude check; Preference and Jobs Found by rules; Job Fit ONLY by the user's
// yes/no replies. Made-up users and made-up searches (no LinkedIn). About 4 Claude calls.
// Runs against DEV with JOB_SEARCH=off for the run. Run: npm run test:evals
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").length;
async function say(phone, text) {
  const before = outgoing(phone);
  await sendText(phone, text);
  await waitForReplies(phone, before + 1);
}
const evals = (phone, lever) => run("evals:forPhone", { phone }).filter((e) => e.lever === lever);
async function waitForEval(phone, lever) {
  for (let i = 0; i < 45; i++) {
    const found = evals(phone, lever);
    if (found.length) return found[0];
    await sleep(2000);
  }
  return null;
}
async function readyUser() {
  const phone = newPhone();
  for (const text of [RESUME, "1", "1", "2"]) await say(phone, text);
  return phone;
}

const job = (n, location = "Mumbai, Maharashtra, India") => ({
  jobId: `92000000${n}`, title: `Senior Product Manager ${n}`, company: `Example Co ${n}`, location, fit: "strong", brokenPreference: null,
});
// A made-up search: saved like a real one (so "3 yes" can find job 3), then scored.
function search(phone, { jobs, preferences, searched, skipped = [], counts = {} }) {
  const searchId = run("history:saveSearch", {
    phone, search: searched, summary: "test", shown: jobs.map((j) => j.jobId), matchKey: "test",
    jobs: jobs.map((j) => ({ jobId: j.jobId, title: j.title, company: j.company, location: j.location, postedOn: "2026-10-10", url: `https://www.linkedin.com/jobs/view/${j.jobId}`, outcome: "shown", fit: "strong", reason: "Test." })),
  });
  run("evals:logSearch", {
    facts: { phone, searchId, alert: false, search: searched, role: "Senior Product Manager", preferences, skipped, shown: jobs, counts: { alreadySent: 0, ...counts } },
  });
}
const FIVE = [1, 2, 3, 4, 5].map((n) => job(n));
const PREFS = { industries: ["Fintech"], location: "Mumbai", days: 7 };
const SEARCHED = `"Senior Product Manager Fintech" in Mumbai, Maharashtra, India, last 7 days`;

const wasOff = (() => {
  try {
    return execSync("npx convex env get JOB_SEARCH", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
})();
execSync("npx convex env set JOB_SEARCH off", { stdio: "ignore" });
try {
  const [a, b] = await Promise.all([readyUser(), readyUser()]);

  // Document Read: a separate Claude check, against the made-up resume (clear: Senior PM, B2B SaaS, Bengaluru).
  const doc = await waitForEval(a, "document_read");
  check("Document Read logged and graded by a separate Claude check", !!doc && doc.judgedBy === "claude" && doc.checks.length === 4, JSON.stringify(doc?.checks));
  check("a clearly written resume scores best", doc?.score === "best", doc?.checks.map((c) => `${c.item}:${c.ok}`).join(" "));

  // Preference + Jobs Found: rules.
  search(a, { jobs: FIVE, preferences: PREFS, searched: SEARCHED });
  let pref = evals(a, "preference")[0];
  let found = evals(a, "jobs_found")[0];
  check("search used role, industry, city, no other site asked → Preference best", pref?.score === "best" && pref.judgedBy === "rules", JSON.stringify(pref?.checks));
  check("5 new jobs, all in the right city → Jobs Found best", found?.score === "best", JSON.stringify(found?.checks));

  search(b, { jobs: [job(6), job(7)], preferences: { ...PREFS, industries: ["Fintech", "RegTech"], portals: ["Naukri"] }, searched: SEARCHED, skipped: ["RegTech"] });
  pref = evals(b, "preference")[0];
  found = evals(b, "jobs_found")[0];
  check("an industry skipped and a job site we can't search → Preference between (2 of 4)", pref?.score === "between", pref?.checks.map((c) => `${c.item}:${c.ok}`).join(" "));
  check("only 2 new jobs → Jobs Found worst", found?.score === "worst", found?.checks[0].note);

  search(b, { jobs: [job(8), job(9), job(10, "Pune, Maharashtra, India")], preferences: PREFS, searched: SEARCHED });
  found = evals(b, "jobs_found")[0];
  check("3 new jobs, one in the wrong city → Jobs Found between", found?.score === "between", found?.checks.map((c) => `${c.item}:${c.ok}`).join(" "));

  // Job Fit: only the user's replies.
  search(a, { jobs: FIVE, preferences: PREFS, searched: SEARCHED });
  let fit = evals(a, "job_fit")[0];
  check("Job Fit starts as pending, judged by user replies only", fit?.score === "pending" && fit.judgedBy === "user_replies", fit?.checks[0].note);
  await say(a, "1 yes");
  fit = evals(a, "job_fit")[0];
  check("1 yes → between", fit?.score === "between", fit?.checks[0].note);
  await say(a, "2 yes");
  await say(a, "4 no");
  await say(a, "5 yes");
  fit = evals(a, "job_fit")[0];
  check("3 yes → best (a 'no' in between doesn't lower it)", fit?.score === "best", fit?.checks[0].note);

  search(b, { jobs: [job(11), job(12)], preferences: PREFS, searched: SEARCHED });
  await say(b, "1 no");
  fit = evals(b, "job_fit")[0];
  check("only some rated, none yes → still pending", fit?.score === "pending", fit?.checks[0].note);
  await say(b, "2 no");
  fit = evals(b, "job_fit")[0];
  check("every job rated no → worst", fit?.score === "worst", fit?.checks[0].note);
} finally {
  execSync(wasOff ? `npx convex env set JOB_SEARCH ${wasOff}` : "npx convex env remove JOB_SEARCH", { stdio: "ignore" });
}
finish();
