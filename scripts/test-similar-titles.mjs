// Similar titles: besides the title on the resume, LinkedIn is also searched for close titles at
// the same level (e.g. "Product Lead"), and jobs with those titles pass the title check.
// About 2 Claude calls, no LinkedIn requests. Run: npm run test:similar
import { RESUME, check, finish, run } from "./test-helpers.mjs";

// ---- Claude suggests close titles ----
const pm = run("jobs:similarForTest", { role: "Senior Product Manager", resume: RESUME });
console.log(`Senior Product Manager -> ${JSON.stringify(pm)}`);
check("suggests 1 to 3 close titles", Array.isArray(pm) && pm.length >= 1 && pm.length <= 3);
check("never the same title again", !pm.some((t) => t.toLowerCase() === "senior product manager"));
check("never more junior or a different job", !pm.some((t) => /associate|junior|intern|project manager|program manager|\b(ii|i|1|2)$/i.test(t)), JSON.stringify(pm));
const ds = run("jobs:similarForTest", { role: "Data Scientist", resume: "Made-up person. Data Scientist, 5 years, Python, machine learning, Example Bank." });
console.log(`Data Scientist -> ${JSON.stringify(ds)}`);
check("works for other jobs too", Array.isArray(ds) && ds.length >= 1 && !ds.some((t) => /intern|junior/i.test(t)));

// ---- which LinkedIn searches run ----
const plan = (role, similar, industries) => run("jobs:planForTest", { role, similar, industries, titles: [] }).plan;
const pages = (p) => p.reduce((sum, s) => sum + s.pages, 0);

const noIndustry = plan("Senior Product Manager", ["Product Lead", "Group Product Manager", "Principal Product Manager"], []);
check("no industry: main title plus the 3 close titles", noIndustry.map((p) => p.query).join("|") === "Senior Product Manager|Product Lead|Group Product Manager|Principal Product Manager", JSON.stringify(noIndustry));
check("no industry: 5 LinkedIn pages at most, spare one on the main title", pages(noIndustry) === 5 && noIndustry[0].pages === 2);

const oneIndustry = plan("Senior Product Manager", ["Product Lead", "Group Product Manager"], ["Fintech"]);
check("one industry: each title with the industry", oneIndustry.map((p) => p.query).join("|") === "Senior Product Manager Fintech|Product Lead Fintech|Group Product Manager Fintech", JSON.stringify(oneIndustry));
check("one industry: still 5 pages at most", pages(oneIndustry) === 5);

const manyIndustries = plan("Senior Product Manager", ["Product Lead", "Group Product Manager"], ["Fintech", "B2B SaaS", "Healthcare"]);
check("several industries: the main title is searched for every one of them", manyIndustries.filter((p) => p.main).length === 3);
check("several industries: close titles only while pages are left", pages(manyIndustries) === 5, JSON.stringify(manyIndustries));

const noSimilar = plan("Senior Product Manager", [], ["Fintech"]);
check("no close titles (not made yet): main title only, all 5 pages on it", noSimilar.length === 1 && noSimilar[0].pages === 5);

// ---- title check ----
const passes = (role, similar, titles) => run("jobs:planForTest", { role, similar, industries: [], titles }).passes;
const [lead, owner, project, associate] = passes("Senior Product Manager", ["Product Owner"], ["Product Lead - Payments", "Senior Product Owner", "Project Manager", "Associate Product Owner"]);
check("product: usual product titles still pass", lead);
check("product: a close title passes", owner);
check("product: a different job still fails", !project);
check("product: a more junior close title still fails", !associate);
const [mle, analyst] = passes("Data Scientist", ["Machine Learning Engineer"], ["Senior Machine Learning Engineer", "Business Analyst"]);
check("other jobs: a close title passes", mle);
check("other jobs: an unrelated title still fails", !analyst);
finish();
