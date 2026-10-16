// "Delete my data" from the chat: asks once, deletes only after DELETE, cancels on anything else,
// waits while a search runs, and leaves nothing behind. Made-up users; about 4 Claude calls.
// Runs against DEV with JOB_SEARCH=off for the run. Run: npm run test:delete-data
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText } from "./test-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out");
// Sends a message and returns the app's reply (the newest message out once a new one appears).
async function say(phone, text) {
  const before = outgoing(phone);
  await sendText(phone, text);
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const now = outgoing(phone);
    if (now.length !== before.length || now.at(-1)?.text !== before.at(-1)?.text) return now.at(-1)?.text ?? "";
  }
  return "";
}
const CONFIRM = /Reply DELETE to confirm/;
const DONE = /Everything you shared with Job Finder is deleted/;
const profile = (phone) => run("profile:getByPhone", { phone });

const wasOff = (() => {
  try {
    return execSync("npx convex env get JOB_SEARCH", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
})();
execSync("npx convex env set JOB_SEARCH off", { stdio: "ignore" });
try {
  // A: a user with a resume and preferences.
  const a = newPhone();
  for (const text of [RESUME, "1", "1", "2"]) await say(a, text);

  let reply = await say(a, "remove banks from my list");
  check("removing one preference is not a delete request", !CONFIRM.test(reply), reply.slice(0, 80));

  reply = await say(a, "delete my data");
  check("'delete my data' asks to confirm first, deletes nothing yet", CONFIRM.test(reply) && profile(a) !== null);
  reply = await say(a, "no");
  check("'no' keeps everything", /nothing was deleted/i.test(reply) && profile(a) !== null);

  run("profile:markSearchingForTest", { phone: a });
  await say(a, "erase everything");
  reply = await say(a, "DELETE");
  check("during a job search: waits, deletes nothing", /middle of a job search/.test(reply) && profile(a) !== null, reply);
  run("profile:finishSearch", { phone: a });

  reply = await say(a, "Delete my data please");
  check("asking again asks again", CONFIRM.test(reply));
  reply = await say(a, "DELETE");
  const left = run("whatsapp:messagesForPhone", { phone: a });
  check("DELETE: everything deleted, says so", DONE.test(reply) && profile(a) === null && run("evals:forPhone", { phone: a }).length === 0, reply);
  check("only the 'Done' message is left, waiting to be delivered", left.length === 1 && DONE.test(left[0].text ?? ""), `${left.length} left`);
  run("erase:dropGoodbye", { phone: a, text: left[0]?.text ?? "", tries: 0 });
  check("once delivered, the 'Done' message is removed too: nothing left", run("whatsapp:messagesForPhone", { phone: a }).length === 0);

  // B: no resume; asks in their own words (Claude), then cancels by just carrying on.
  const b = newPhone();
  await say(b, "hi");
  reply = await say(b, "please get rid of all the information you have on me, I'm done with this");
  check("asked in other words: Claude recognises it and asks to confirm", CONFIRM.test(reply), reply.slice(0, 80));
  reply = await say(b, "forget me");
  check("short wording works too", CONFIRM.test(reply));
  reply = await say(b, "delete");
  check("'delete' in small letters confirms too", DONE.test(reply), reply);
  run("erase:dropGoodbye", { phone: b, text: reply, tries: 0 });
} finally {
  execSync(wasOff ? `npx convex env set JOB_SEARCH ${wasOff}` : "npx convex env remove JOB_SEARCH", { stdio: "ignore" });
  run("erase:eraseTestUsers", {});
}
finish();
