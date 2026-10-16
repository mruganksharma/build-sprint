// Company career-page jobs in the search: read for the user's city and dates, the company list only
// grows, one background refresh at a time, and the job list says where each job came from.
// No Claude calls: uses the saved "Fintech in Mumbai" list and made-up data. Run: npm run test:company-jobs
import { check, finish, newPhone, run } from "./test-helpers.mjs";

// 1. Reading jobs (real company job lists, free).
const days = 30;
const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const r = run("careers:jobsFor", { industries: ["Fintech"], city: "Mumbai", days });
check("reads jobs from companies' own job lists", r.jobs.length > 0 && r.companies > 0, `${r.jobs.length} jobs from ${r.companies} companies`);
check("only jobs in their city", r.jobs.every((j) => /mumbai|bombay|thane/i.test(j.location)), r.jobs.map((j) => j.location).filter((l) => !/mumbai|bombay|thane/i.test(l)).join("; "));
check("only jobs from their time window", r.jobs.every((j) => j.postedOn >= cutoff));
check("each job says which company page it came from, never LinkedIn", r.jobs.every((j) => / careers page$/.test(j.source) && !/linkedin/i.test(j.url) && !/^\d+$/.test(j.jobId)));
check("each job can be checked by Claude (has its description, or where to fetch it)", r.jobs.every((j) => j.description || j.detailUrl));
check("no city ('India'): no company jobs, no background work", run("careers:jobsFor", { industries: ["Fintech"], city: "India", days }).jobs.length === 0);

// 2. The company list only grows (made-up list).
const key = `test-${Date.now()}|testcity`;
const co = (name) => ({ name, website: `${name.toLowerCase()}.example` });
run("companyLists:save", { key, industry: "test", city: "testcity", companies: [co("Alpha"), co("Beta")] });
const size = run("companyLists:save", { key, industry: "test", city: "testcity", companies: [co("Gamma"), co("Beta")], closed: ["Alpha"] });
const names = run("companyLists:get", { key }).companies.map((c) => c.name).sort().join(",");
check("weekly refresh adds new companies, keeps the rest, drops only closed ones", size === 2 && names === "Beta,Gamma", names);

// 3. One background refresh at a time.
check("first refresh may start", run("companyLists:claimPrepare", { key }) === true);
check("a second one for the same industry and city waits", run("companyLists:claimPrepare", { key }) === false);
run("companyLists:removeForTest", { key });

// 4. The job list message (made-up jobs; replies are saved, not really sent).
const phone = newPhone();
run("jobs:sendResultsForTest", {
  phone, days: 7, nearMisses: [],
  matches: [
    { title: "Senior Product Manager", company: "Example Pay", postedOn: "2026-10-10", url: "https://job-boards.greenhouse.io/examplepay/jobs/4738327005", source: "Example Pay careers page" },
    { title: "Product Manager", company: "Example Bank", postedOn: "2026-10-09", url: "https://in.linkedin.com/jobs/view/product-manager-at-example-bank-4425296556" },
  ],
});
const text = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text).join("\n");
check("header mentions company career pages", /on LinkedIn and company career pages/.test(text), text.split("\n")[0]);
check("a company job says where it's from and keeps its own link", text.includes("From the Example Pay careers page") && text.includes("https://job-boards.greenhouse.io/examplepay/jobs/4738327005"));
check("a LinkedIn job still gets the short LinkedIn link", text.includes("https://www.linkedin.com/jobs/view/4425296556") && !text.includes("product-manager-at-example-bank"));
run("erase:eraseUser", { phone });
finish();
