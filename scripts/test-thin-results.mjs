// When few jobs fit: the close-but-not-quite jobs are listed with the rule they missed, and the app
// offers to look further back; a one-word reply starts that search. Uses made-up search results
// (no LinkedIn, no job checks), so only 2 Claude calls: one per made-up resume.
// Runs against the DEV deployment with JOB_SEARCH=off for the run. Run: npm run test:thin
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const job = (n) => ({ title: `Product Manager ${n}`, company: `Example Co ${n}`, postedOn: "2026-10-10", url: `https://www.linkedin.com/jobs/view/90000000${n}` });
const near = (n, rule) => ({ ...job(n), title: `Senior PM ${n}`, company: `Sample Bank ${n}`, brokenPreference: rule });
const NEAR = [near(11, "industry must be Fintech: this is a bank"), near(12, "industry must be Fintech: this is a consulting firm")];

const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);
const profile = (phone) => run("profile:getByPhone", { phone });
// Sends made-up results; returns the new messages the app sent.
async function results(phone, days, matches, nearMisses, expectMessages, skipped = []) {
  const before = outgoing(phone).length;
  run("jobs:sendResultsForTest", { phone, days, matches, nearMisses, skipped });
  await waitForReplies(phone, before + expectMessages);
  return outgoing(phone).slice(before);
}
async function say(phone, text) {
  const before = outgoing(phone).length;
  await sendText(phone, text);
  await waitForReplies(phone, before + 1);
  return outgoing(phone).at(-1);
}
async function readyUser(daysAnswer) {
  const phone = newPhone();
  for (const text of [RESUME, "1", "1", daysAnswer]) await say(phone, text);
  return phone;
}

const wasOff = (() => {
  try {
    return execSync("npx convex env get JOB_SEARCH", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
})();
execSync("npx convex env set JOB_SEARCH off", { stdio: "ignore" });
try {
  // User 1 asked for the last 7 days.
  const a = await readyUser("2");
  let msgs = await results(a, 7, [job(1)], NEAR, 2);
  let extra = msgs.at(-1) ?? "";
  check("1 job fits: close jobs listed with the rule each missed",
    /2 more were close/.test(extra) && /Sample Bank 11 \(industry must be Fintech: this is a bank\)/.test(extra) && /Sample Bank 12/.test(extra), extra);
  check("1 job fits: offers the last 30 days, and waits for the answer",
    /Only 1 new job from the last 7 days\. Want me to look at the last 30 days too\? Reply 30\./.test(extra) && profile(a).stage === "widen_offer", extra);
  let reply = await say(a, "30");
  check("replying 30 looks back 30 days and searches", profile(a).preferences.days === 30 && profile(a).stage === "ready" && /^Searching LinkedIn/.test(reply), reply);

  msgs = await results(a, 30, [job(2)], NEAR.slice(0, 1), 2);
  extra = msgs.at(-1) ?? "";
  check("already 30 days: close job still listed, no offer to look further", /1 more was close/.test(extra) && !/Reply \d+\./.test(extra) && profile(a).stage === "ready", extra);

  msgs = await results(a, 30, [1, 2, 3, 4, 5].map(job), NEAR, 1);
  check("5 jobs fit: no close-jobs list, no offer", msgs.length === 1 && !/close, but/.test(msgs.join()) && profile(a).stage === "ready", msgs.join(" || "));

  msgs = await results(a, 30, [1, 2, 3, 4, 5].map(job), [], 1, ["Fintech"]);
  check("LinkedIn turned one industry away: jobs still sent, and says which was skipped",
    /Product Manager 1/.test(msgs.join()) && /LinkedIn was limiting searches, so I couldn't search Fintech this time\. Reply 'jobs' in about 15 minutes to include it\./.test(msgs.at(-1)), msgs.at(-1));

  // User 2 asked for the last 24 hours.
  const b = await readyUser("1");
  msgs = await results(b, 1, [], NEAR, 1);
  check("nothing fits: says so, lists close jobs, offers 7 days in one message",
    msgs.length === 1 && /found nothing new that fits/.test(msgs[0]) && /2 more were close/.test(msgs[0]) && /Nothing new from the last 24 hours\. Want me to look at the last 7 days too\? Reply 7\./.test(msgs[0]) && profile(b).stage === "widen_offer", msgs[0]);
  reply = await say(b, "jobs");
  check("'jobs' instead: searches as before, days unchanged", profile(b).preferences.days === 1 && profile(b).stage === "ready" && /^Searching LinkedIn/.test(reply), reply);
  await results(b, 1, [], [], 1);
  msgs = await results(b, 1, [], [], 1);
  check("a second thin search in a row offers again", /Reply 7\./.test(msgs[0]) && profile(b).stage === "widen_offer", msgs[0]);
  reply = await say(b, "yes");
  check("a plain 'yes' to the offer looks back 7 days", profile(b).preferences.days === 7 && /^Searching LinkedIn/.test(reply), reply);
} finally {
  execSync(wasOff ? `npx convex env set JOB_SEARCH ${wasOff}` : "npx convex env remove JOB_SEARCH", { stdio: "ignore" });
}
finish();
