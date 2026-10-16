// Erasing a tester: everything stored for their number goes, they start again as a new user, and
// nobody else's data is touched. Made-up users and a made-up search (no LinkedIn). About 4 Claude
// calls. Runs against DEV with JOB_SEARCH=off for the run. Run: npm run test:erase
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const messages = (phone) => run("whatsapp:messagesForPhone", { phone });
const outgoing = (phone) => messages(phone).filter((m) => m.direction === "out").length;
async function say(phone, text) {
  const before = outgoing(phone);
  await sendText(phone, text);
  await waitForReplies(phone, before + 1);
}
async function readyUser() {
  const phone = newPhone();
  for (const text of [RESUME, "1", "1", "2"]) await say(phone, text);
  return phone;
}
const job = { jobId: "930000001", title: "Senior Product Manager", company: "Example Co", location: "Mumbai, Maharashtra, India" };

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

  // a: gets a job list, rates a job, turns on a daily alert.
  const searchId = run("history:saveSearch", {
    phone: a, search: "test", summary: "test", shown: [job.jobId], matchKey: "test",
    jobs: [{ ...job, postedOn: "2026-10-10", url: `https://www.linkedin.com/jobs/view/${job.jobId}`, outcome: "shown", fit: "strong", reason: "Test." }],
  });
  run("evals:logSearch", {
    facts: { phone: a, searchId, alert: false, search: "test", role: "Senior Product Manager", preferences: null, skipped: [], shown: [{ ...job, fit: "strong", brokenPreference: null }], counts: {} },
  });
  run("jobs:sendResultsForTest", { phone: a, days: 7, matches: [{ title: job.title, company: job.company, postedOn: "2026-10-10", url: "https://example.com" }], nearMisses: [] });
  await say(a, "1 yes");
  await say(a, "1");
  check("before: a has a profile with a daily alert booked", run("profile:getByPhone", { phone: a })?.alertHour === 9 && run("alerts:nextAlertAt", { phone: a }) !== null);
  const bMessages = messages(b).length;
  const bEvals = run("evals:forPhone", { phone: b }).length;

  const result = run("erase:eraseUser", { phone: a });
  check("erase reports what it removed", result.erased && result.rows.profile === 1 && result.rows.messages > 0 && result.rows.searches > 0 && result.rows.evals > 0, JSON.stringify(result.rows));
  check("profile, resume and preferences gone", run("profile:getByPhone", { phone: a }) === null);
  check("messages gone", messages(a).length === 0);
  check("dashboard scores gone", run("evals:forPhone", { phone: a }).length === 0);
  check("daily alert cancelled", run("alerts:nextAlertAt", { phone: a }) === null);
  check("the note never shows the full number", !result.note.includes(a), result.note);

  check("the other tester is untouched", messages(b).length === bMessages && run("evals:forPhone", { phone: b }).length === bEvals && run("profile:getByPhone", { phone: b }) !== null);

  await say(a, "hi");
  const reply = messages(a).filter((m) => m.direction === "out").at(-1)?.text ?? "";
  check("after erase, 'hi' is treated as a brand-new user (asks for a resume)", /resume/i.test(reply) && run("profile:getByPhone", { phone: a }) === null, reply.slice(0, 80));

  check("erasing a number with nothing stored says so", run("erase:eraseUser", { phone: newPhone() }).erased === false);
  run("erase:eraseUser", { phone: a });
  run("erase:eraseUser", { phone: b });
} finally {
  execSync(wasOff ? `npx convex env set JOB_SEARCH ${wasOff}` : "npx convex env remove JOB_SEARCH", { stdio: "ignore" });
  run("profile:clearTestAlerts", {});
}
finish();
