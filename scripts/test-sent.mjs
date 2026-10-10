// Jobs already sent (and close jobs already listed) are remembered across preference changes,
// so they're never sent again as new or listed twice.
// Saves made-up searches straight to the DEV database: no LinkedIn, no Claude calls.
// Run: npm run test:sent
import { check, finish, newPhone, run } from "./test-helpers.mjs";

const phone = newPhone();
const job = (jobId, outcome) => ({ jobId, title: "Senior Product Manager", company: `Example ${jobId}`, location: "Mumbai", postedOn: "2026-10-10", url: `https://www.linkedin.com/jobs/view/${jobId}`, outcome });
const save = (matchKey, shown, jobs, closeShown) => run("history:saveSearch", { phone, search: "test", summary: "test", shown, matchKey, jobs, ...(closeShown ? { closeShown } : {}) });

save("prefs-before", ["9100000001"], [job("9100000001", "shown"), job("9100000002", "wrong_title")]);
save("prefs-after", ["9100000003"], [job("9100000003", "shown"), job("9100000004", "broke_preference")], ["9100000004"]);

const { sent } = run("history:sentJobIds", { phone, since: Date.now() - 30 * 24 * 60 * 60 * 1000 });
check("jobs sent under both old and new preferences are remembered", sent.includes("9100000001") && sent.includes("9100000003"), sent.join(", "));
check("jobs that were never sent aren't counted", !sent.includes("9100000002"), sent.join(", "));
check("close jobs already listed are remembered, and don't count as sent",
  run("history:sentJobIds", { phone, since: 0 }).listedClose.join() === "9100000004" && !sent.includes("9100000004"));
check("nothing counts from before the time asked for", run("history:sentJobIds", { phone, since: Date.now() + 60000 }).sent.length === 0);
finish();
