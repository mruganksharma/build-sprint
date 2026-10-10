// Milestones 4a/4b test with REAL LinkedIn searches: results arrive in the chat, at most 10 jobs are
// checked by Claude, a second search reuses earlier verdicts, "1 yes" rates a job from the list, and
// a search with no results asks for another job site. About 10-20 Claude calls.
// Turns JOB_SEARCH on for the run, then off again. Run: npm run test:search
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForMatch, waitForReplies } from "./test-helpers.mjs";

const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);
const CHECKED = ["shown", "not_a_fit", "broke_preference", "unchecked"];
const checkedIn = (counts) => CHECKED.reduce((sum, o) => sum + (counts[o] ?? 0), 0);

// Sends answers one by one, waiting for each reply.
async function answer(phone, ...texts) {
  for (const text of texts) {
    const before = outgoing(phone).length;
    await sendText(phone, text);
    await waitForReplies(phone, before + 1);
  }
}
// Waits (up to 6 minutes) for the next search to finish: its results, or its "nothing" message.
async function waitForResults(phone, after) {
  for (let i = 0; i < 72; i++) {
    const out = outgoing(phone).slice(after);
    const hit = out.findIndex((t) => /^Found \d+ new jobs? for you|found nothing new|had no .*jobs/.test(t));
    if (hit >= 0) return out.slice(hit);
    await new Promise((r) => setTimeout(r, 5000));
  }
  return [];
}

execSync("npx convex env remove JOB_SEARCH", { stdio: "ignore" });
try {
  // ---- first search ----
  const phone = newPhone();
  await answer(phone, RESUME, "1", "1");
  await sendText(phone, "2");
  const allSet = await waitForMatch(phone, /^All set/);
  check("finishing the questions starts a search", /^All set\. Searching LinkedIn .* from the last 7 days now/.test(allSet ?? ""), allSet);
  const afterAllSet = outgoing(phone).length;
  await new Promise((r) => setTimeout(r, 8000));
  await sendText(phone, "jobs");
  const busy = await waitForMatch(phone, /still searching/);
  check("asking again mid-search says still searching", /still searching/.test(busy ?? ""), busy);

  const results = await waitForResults(phone, afterAllSet);
  console.log(`\n--- first search, what the user received ---\n${results.join("\n\n--- next message ---\n")}\n---\n`);
  const found = /^Found \d+ new jobs? for you/.test(results[0] ?? "");
  check("results arrive in the chat", results.length > 0, (results[0] ?? "").slice(0, 80));
  let counts = run("history:countsForPhone", { phone });
  check("Claude checks at most 10 jobs per search", checkedIn(counts.perSearch[0]) <= 10, JSON.stringify(counts.perSearch[0]));
  if (found) {
    const jobs = results.join("\n\n").split(/\n\n(?=\d+\. )/).filter((p) => /^\d+\. /.test(p));
    check("every job has fit, reason and LinkedIn link, numbered from 1",
      jobs.length > 0 && jobs.every((j, i) => j.startsWith(`${i + 1}. `) && /(Strong|Partial) fit/.test(j) && /\nWhy: /.test(j) && /linkedin\.com\/jobs\/view\/\d+/.test(j)),
      `${jobs.length} jobs`);
    check("every message fits in WhatsApp", results.every((m) => m.length <= 4096));
    check("ends by asking which ones they like", /reply with a job number and yes or no/.test(results.at(-1)));

    // ---- rating from the list ----
    const firstJob = jobs[0].split("\n")[0].replace(/^1\. /, "").replace(" – ", " at ");
    await sendText(phone, "1 yes");
    const rated = await waitForMatch(phone, /^Got it: I'll look out for more jobs like/);
    check("'1 yes' saves job 1 as a like", rated?.includes(firstJob) && run("profile:getByPhone", { phone }).preferences.likes?.includes(firstJob), rated);
    await sendText(phone, "99 no");
    const none = await waitForMatch(phone, /no job 99/);
    check("'99 no' says there's no such job", /no job 99/.test(none ?? ""), none);
  }

  // ---- second search: reuses verdicts, doesn't resend ----
  const beforeSecond = outgoing(phone).length;
  await sendText(phone, "jobs");
  const second = await waitForResults(phone, beforeSecond);
  counts = run("history:countsForPhone", { phone });
  const s2 = counts.perSearch[0];
  console.log(`--- second search: ${(second[0] ?? "").split("\n")[0]}\n    outcomes: ${JSON.stringify(s2)}\n`);
  check("second search reuses earlier verdicts instead of resending", counts.searches === 2 && (s2.already_sent ?? 0) > 0 && (s2.shown ?? 0) <= 10, JSON.stringify(s2));

  // ---- a search with no results asks for another job site ----
  const lonely = newPhone();
  await answer(lonely, RESUME, "2", "Underwater basket weaving", "2", "Leh");
  await sendText(lonely, "1");
  const nothing = await waitForMatch(lonely, /another job site/);
  check("nothing found: says so and asks for another job site", /another job site you'd like me to search/.test(nothing ?? ""), (nothing ?? "").slice(0, 120));
  await sendText(lonely, "Naukri");
  const noted = await waitForMatch(lonely, /^Noted: Naukri/);
  check("the job site is saved", /^Noted: Naukri/.test(noted ?? "") && run("profile:getByPhone", { phone: lonely }).preferences.portals?.includes("Naukri"), noted);
} finally {
  execSync("npx convex env set JOB_SEARCH off", { stdio: "ignore" });
}
finish();
