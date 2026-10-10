// Someone the app knows says hi again: a free "Welcome back" with what it's searching for, or the
// question they were in the middle of. One made-up user, about 2 Claude calls (the resume, and a
// second "hi" in a row, which Claude answers so the app doesn't repeat itself).
// Runs against the DEV deployment with JOB_SEARCH=off for the run. Run: npm run test:greeting
import { execSync } from "node:child_process";
import { RESUME, check, finish, newPhone, run, sendText, waitForReplies } from "./test-helpers.mjs";

const outgoing = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);
const stage = (phone) => run("profile:getByPhone", { phone })?.stage;
async function say(phone, text) {
  const before = outgoing(phone).length;
  await sendText(phone, text);
  await waitForReplies(phone, before + 1);
  return outgoing(phone).at(-1);
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
  const phone = newPhone();
  let reply = await say(phone, "hi");
  check("new person: asked for their resume", /^Hi! Send me your resume/.test(reply), reply);

  await say(phone, RESUME);
  reply = await say(phone, "Hello!");
  check("mid-question: welcome back, the same question again, still on it",
    /^Welcome back! Let's pick up where we left off\.\n\nYour resume shows you work in .*\n1\. Same/.test(reply) && stage(phone) === "industry_choice", reply);

  for (const text of ["1", "1", "2"]) await say(phone, text);
  reply = await say(phone, "hey there");
  check("all set up: welcome back with industry, city and how recent",
    /^Welcome back! I'm looking for .+ jobs in .+ from the last 7 days\.\n\nReply 'jobs' for new jobs/.test(reply), reply);

  const again = await say(phone, "hi");
  check("a second hi in a row isn't answered the same way", !!again && again !== reply, again);

  run("profile:markSearchingForTest", { phone });
  reply = await say(phone, "good morning");
  check("while searching: welcome back, and says the jobs are on the way", /^Welcome back![\s\S]*I'm searching right now/.test(reply), reply);
} finally {
  execSync(wasOff ? `npx convex env set JOB_SEARCH ${wasOff}` : "npx convex env remove JOB_SEARCH", { stdio: "ignore" });
}
finish();
