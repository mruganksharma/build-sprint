// Company finder (step 1 of the second job source): a list of companies for an industry and city,
// saved and reused. Free while the saved "Fintech in Mumbai" list is under a week old; otherwise
// the first call finds it again (1 Claude call with web search). Run: npm run test:companies
import { check, finish, run } from "./test-helpers.mjs";

const first = run("companies:findCompanies", { industry: "Fintech", city: "Mumbai" });
check("finds a real-sized list", !!first && first.companies.length >= 15, `${first?.companies.length} companies`);
const names = first.companies.map((c) => c.name.toLowerCase());
check("no company listed twice", new Set(names).size === names.length);
check("websites are plain domains (or left empty)", first.companies.every((c) => c.website === null || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(c.website)));
const again = run("companies:findCompanies", { industry: " FINTECH", city: "mumbai " });
check("asked again (any spelling): the saved list, no new Claude call", again.fromSaved && again.companies.length === first.companies.length);

// Step 2's free readers: Keka and SmartRecruiters (plain web requests, no Claude).
const keka = run("careers:readBoardForTest", { system: "keka", slug: "jupiter" });
check("Keka: reads a company's open jobs, with how many are in India", !!keka && keka.total >= 0 && keka.inIndia <= keka.total, JSON.stringify(keka));
check("Keka: a company that isn't on Keka is 'not on it'", run("careers:readBoardForTest", { system: "keka", slug: "notarealcompany-x7q" }) === null);
const sr = run("careers:readBoardForTest", { system: "smartrecruiters", slug: "BoschGroup" });
check("SmartRecruiters: reads a big company's recent jobs, some in India", !!sr && sr.total > 0 && sr.inIndia > 0, JSON.stringify(sr));
check("SmartRecruiters: an old left-over company page (no jobs in 90 days) is 'not on it'", run("careers:readBoardForTest", { system: "smartrecruiters", slug: "upstox" }) === null);
finish();
