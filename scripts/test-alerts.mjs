// Daily job alerts: asked once after the first reply to a job list; answers by number, words or a
// time; changed later in any wording; each user's alert is booked for their time (and cancelled
// when stopped); an alert sends only new jobs and nothing when there are none. Made-up users and made-up job lists (no LinkedIn).
// About 6 Claude calls. Runs against DEV with JOB_SEARCH=off for the run. Run: npm run test:alerts
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const QUESTION = /Want me to send you new jobs every day\?\n1\. Yes, every morning/;
const job = (n) => ({ title: `Product Manager ${n}`, company: `Example Co ${n}`, postedOn: "2026-10-10", url: `https://www.linkedin.com/jobs/view/91000000${n}` });
const FIVE = [1, 2, 3, 4, 5].map(job);
const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);
const profile = (phone) => run("profile:getByPhone", { phone });
// The booked alert's time as India-time hour and minute, or null if none is booked.
const booked = (phone) => {
  const at = run("alerts:nextAlertAt", { phone });
  if (at === null) return null;
  const india = new Date(at + 5.5 * 60 * 60 * 1000);
  return { hour: india.getUTCHours(), minute: india.getUTCMinutes(), inHours: (at - Date.now()) / 3600000 };
};
const bookedAt = (phone, hour) => {
  const b = booked(phone);
  return !!b && b.hour === hour && b.minute < 15 && b.inHours > 0 && b.inHours <= 24;
};
async function say(phone, text) {
  const before = outgoing(phone).length;
  await sendText(phone, text);
  await waitForReplies(phone, before + 1);
  return outgoing(phone).at(-1);
}
async function list(phone, matches = FIVE, alert = false) {
  const before = outgoing(phone).length;
  run("jobs:sendResultsForTest", { phone, days: 7, matches, nearMisses: [], alert });
  if (matches.length) await waitForReplies(phone, before + 1);
  else await new Promise((r) => setTimeout(r, 6000)); // give a wrongly sent message time to show up
  return outgoing(phone).slice(before);
}
async function readyUser() {
  const phone = newPhone();
  for (const text of [RESUME, "1", "1", "2"]) await say(phone, text);
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
  const [a, b, c, d] = await Promise.all([readyUser(), readyUser(), readyUser(), readyUser()]);

  let reply = await say(a, "1 yes");
  check("no job list yet: not asked about alerts", !QUESTION.test(reply) && !profile(a).alertsAsked, reply);
  await list(a);
  reply = await say(a, "1 yes");
  check("first reply after a job list: answered, then asked about daily alerts", QUESTION.test(reply) && profile(a).stage === "alerts_choice", reply);
  reply = await say(a, "2");
  check("'2' → every evening at 6 pm, saved", profile(a).alertHour === 18 && profile(a).stage === "ready" && /6 pm \(India time\)/.test(reply), reply);
  await list(a);
  reply = await say(a, "1 yes");
  check("asked only once", !QUESTION.test(reply), reply);
  reply = await say(a, "actually can u send them early in the morning around 7 instead");
  check("moved in plain words (Claude): 7 am, and booked for 7 am", profile(a).alertHour === 7 && bookedAt(a, 7), `${JSON.stringify(booked(a))} | ${reply}`);
  reply = await say(a, "pls stop the daily job msgs");
  check("stopped in plain words (Claude), and the booking is cancelled", profile(a).alertHour === null && booked(a) === null, reply);

  await list(b);
  await say(b, "1 yes");
  reply = await say(b, "No thanks");
  check("'No thanks' → alerts off, not asked again", profile(b).alertHour === null && profile(b).alertsAsked && profile(b).stage === "ready", reply);

  await list(c);
  await say(c, "1 yes");
  reply = await say(c, "3");
  check("'3' → asks what time", /What time should I send them\?/.test(reply) && profile(c).stage === "alerts_time", reply);
  reply = await say(c, "7:30 pm");
  check("'7:30 pm' → 7 pm, saved", profile(c).alertHour === 19 && /7 pm/.test(reply), reply);

  await list(d);
  await say(d, "1 yes");
  reply = await say(d, "8 am");
  check("a time straight away ('8 am') works too", profile(d).alertHour === 8, reply);

  check("8 am is booked for the next 8 am (India time), within 24 hours", bookedAt(d, 8), JSON.stringify(booked(d)));
  check("no booking for someone who said no", booked(b) === null);
  run("alerts:fireNowForTest", { phone: d });
  await new Promise((r) => setTimeout(r, 4000));
  check("when an alert runs, the next day's is booked", bookedAt(d, 8), JSON.stringify(booked(d)));

  let sent = await list(d, [], true);
  check("alert with no new jobs: no message at all", sent.length === 0, sent.join(" || "));
  sent = await list(d, [job(6), job(7)], true);
  check("alert with new jobs: sends them", /^Your daily job alert: 2 new jobs/.test(sent[0] ?? "") && /Product Manager 6/.test(sent.join()), sent[0]);
} finally {
  run("profile:clearTestAlerts", {}); // so the hourly run never searches for made-up numbers
  execSync(wasOff ? `npx convex env set JOB_SEARCH ${wasOff}` : "npx convex env remove JOB_SEARCH", { stdio: "ignore" });
}
finish();
