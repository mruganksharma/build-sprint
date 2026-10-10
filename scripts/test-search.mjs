// Milestone 4a test: a made-up user finishes the questions, and a REAL LinkedIn search runs and
// sends jobs in the chat. Uses about 20-30 Claude calls. Turns JOB_SEARCH on for the run, then off.
// Run: npm run test:search
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);

execSync("npx convex env remove JOB_SEARCH", { stdio: "ignore" });
try {
  const phone = newPhone();
  await sendText(phone, RESUME);
  await waitForReplies(phone, 1);
  await sendText(phone, "1");
  await waitForReplies(phone, 2);
  await sendText(phone, "1");
  const allSet = await waitForReplies(phone, 3);
  check("finishing the questions starts a search", /^All set\. Searching LinkedIn/.test(allSet ?? ""), allSet);

  await new Promise((r) => setTimeout(r, 8000));
  await sendText(phone, "jobs");
  const busy = await waitForReplies(phone, 4);
  check("asking again mid-search says still searching", /still searching/.test(busy ?? ""), busy);

  // Wait (up to 6 minutes) for the results.
  let results = [];
  for (let i = 0; i < 72 && !results.length; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    results = outgoing(phone).slice(4);
  }
  const first = results[0] ?? "";
  console.log(`\n--- what the user received ---\n${results.join("\n\n--- next message ---\n")}\n---\n`);
  const found = /^Found \d+ jobs? for you/.test(first);
  const none = /none fit well|had no .*jobs/.test(first);
  check("results arrive in the chat", found || none, first.slice(0, 80));
  if (found) {
    const all = results.join("\n\n");
    const jobs = all.split(/\n\n(?=\d+\. )/).filter((p) => /^\d+\. /.test(p));
    check("every job has fit, reason and LinkedIn link",
      jobs.length > 0 && jobs.every((j) => /(Strong|Partial) fit/.test(j) && /\nWhy: /.test(j) && /linkedin\.com\/jobs\/view\/\d+/.test(j)),
      `${jobs.length} jobs`);
    check("jobs are numbered from 1", jobs.every((j, i) => j.startsWith(`${i + 1}. `)), jobs.map((j) => j.split(".")[0]).join(","));
    check("every message fits in WhatsApp", results.every((m) => m.length <= 4096));
    check("ends with what to do next", /Reply 'jobs' to search again/.test(results.at(-1)));
  }
  const counts = run("history:countsForPhone", { phone });
  check("search and every job looked at are saved", counts.searches === 1 && counts.jobs > 0, JSON.stringify(counts));
} finally {
  execSync("npx convex env set JOB_SEARCH off", { stdio: "ignore" });
}
finish();
