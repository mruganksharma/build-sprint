import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

// A second source of jobs, independent of LinkedIn. Step 2: for each company in a list (see
// companies.ts), find where it lists its open jobs. Free hiring-system job lists we can read:
// Greenhouse, Lever, Ashby, Workable, SmartRecruiters (official public lists) and Keka (the same
// public list its careers widget shows visitors). No Claude: plain web requests.
//   1. Open the company's website, find its careers page, and look for a link to a hiring system.
//   2. If none, try the company's name on each hiring system.
//   3. If still nothing, Firecrawl (a paid outside service, see PRODUCT.md) opens the careers page
//      like a browser, so pages built with JavaScript show their links too, and we look for a
//      hiring-system link there. About 1 Firecrawl credit per page; at most 2 pages per company,
//      and a found list is re-read for free next time.
// Companies on other hiring systems (Darwinbox, Workday, ...) are noted, so we know how many
// we'd miss. Try it from the terminal:
//   npx convex run careers:findBoards '{"industry": "Fintech", "city": "Mumbai"}'

const KEEP_DAYS = 7;
const TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 1024 * 1024;
const AT_ONCE = 5; // companies checked at the same time
const FIRECRAWL_PAGES = 2; // most Firecrawl pages opened per company
const RECENT_DAYS = 90; // SmartRecruiters: older jobs are left-over pages, not real openings
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

type Readable = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "keka";
const READABLE: Readable[] = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "keka"];
type Board = Omit<Doc<"companyBoards">, "_id" | "_creationTime" | "key" | "name" | "checkedAt">;

// Links on a careers page that point to a hiring system we can read, and the company's name there.
const READABLE_LINKS: [Readable, RegExp][] = [
  ["greenhouse", /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i],
  ["lever", /jobs\.lever\.co\/([a-z0-9_.-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i],
  ["workable", /apply\.workable\.com\/([a-z0-9_-]+)/i],
  ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
  ["keka", /\/\/([a-z0-9-]+)\.keka\.com\/careers/i],
];
// Hiring systems we can't read for free yet, by the address their links use.
const OTHER_SYSTEMS: [string, RegExp][] = [
  ["Darwinbox", /\.darwinbox\.(?:in|com)/i],
  ["Zoho Recruit", /zohorecruit\.|recruit\.zoho\./i],
  ["Workday", /myworkdayjobs\.com|\.wd\d\.myworkday/i],
  ["Freshteam", /\.freshteam\.com/i],
  ["SuccessFactors", /successfactors\.(?:com|eu)|jobs\.sap\.com/i],
  ["Oracle", /oraclecloud\.com\/hcmUI/i],
  ["iCIMS", /\.icims\.com/i],
  ["Taleo", /taleo\.net/i],
  ["Instahyre", /instahyre\.com/i],
  ["Naukri", /naukri\.com/i],
];
const CAREERS_PATHS = ["/careers", "/careers/", "/jobs", "/jobs/", "/join-us", "/about/careers", "/company/careers"];
const NOT_A_SLUG = new Set(["embed", "jobs", "job", "search", "v1", "api", "careers", "www", "cdn"]);

export const findBoards = internalAction({
  args: { industry: v.string(), city: v.string(), refresh: v.optional(v.boolean()) }, // refresh: check every company again
  returns: v.union(
    v.object({
      companies: v.number(),
      readable: v.number(),
      readableWithIndiaJobs: v.number(),
      jobsInIndia: v.number(),
      other: v.array(v.object({ name: v.string(), system: v.string() })),
      none: v.array(v.string()),
      notChecked: v.array(v.string()),
      boards: v.array(v.object({ name: v.string(), system: v.string(), slug: v.string(), jobsTotal: v.number(), jobsInIndia: v.number() })),
    }),
    v.null(),
  ),
  handler: async (ctx, { industry, city, refresh }) => {
    const key = `${industry.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
    const list = await ctx.runQuery(internal.companyLists.get, { key });
    if (!list) return null; // find the companies first (companies:findCompanies)

    const results: (Board & { name: string; busy?: boolean })[] = [];
    for (let i = 0; i < list.companies.length; i += AT_ONCE) {
      const batch = list.companies.slice(i, i + AT_ONCE);
      results.push(
        ...(await Promise.all(
          batch.map(async (company) => {
            const boardKey = company.website ?? company.name.toLowerCase();
            const saved = await ctx.runQuery(internal.careers.getBoard, { key: boardKey });
            if (saved && !refresh && Date.now() - saved.checkedAt < KEEP_DAYS * 24 * 60 * 60 * 1000) return { ...saved, name: company.name };
            // A list found before: re-read it for free instead of searching again.
            const known = saved?.slug && READABLE.includes(saved.system as Readable) ? saved : null;
            const jobs = known ? await readBoard(known.system as Readable, known.slug!) : null;
            const board: Board | null = known && jobs
              ? { system: known.system, slug: known.slug, careersUrl: known.careersUrl, jobsTotal: jobs.total, jobsInIndia: jobs.inIndia }
              : await findBoard(company.name, company.website).catch((e) => {
                  if (e instanceof FirecrawlBusy) return null; // not saved: checked again next time
                  throw e;
                });
            if (!board) return { system: "none" as const, name: company.name, busy: true };
            await ctx.runMutation(internal.careers.saveBoard, { key: boardKey, name: company.name, ...board });
            return { ...board, name: company.name };
          }),
        )),
      );
    }

    const readable = results.filter((r) => r.system !== "other" && r.system !== "none");
    return {
      companies: results.length,
      readable: readable.length,
      readableWithIndiaJobs: readable.filter((r) => (r.jobsInIndia ?? 0) > 0).length,
      jobsInIndia: readable.reduce((sum, r) => sum + (r.jobsInIndia ?? 0), 0),
      other: results.filter((r) => r.system === "other").map((r) => ({ name: r.name, system: r.otherSystem ?? "unknown" })),
      none: results.filter((r) => r.system === "none" && !r.busy).map((r) => r.name),
      notChecked: results.filter((r) => r.busy).map((r) => r.name), // Firecrawl was busy; checked next time
      boards: readable.map((r) => ({ name: r.name, system: r.system, slug: r.slug ?? "", jobsTotal: r.jobsTotal ?? 0, jobsInIndia: r.jobsInIndia ?? 0 })),
    };
  },
});

async function findBoard(name: string, website: string | null): Promise<Board> {
  // 1. The company's own careers page, and the hiring-system link on it.
  let careersUrl: string | undefined;
  let otherSystem: string | undefined;
  const careersLike: string[] = []; // careers pages that opened, for Firecrawl to look at again
  if (website) {
    for (const url of await careersPages(website)) {
      const html = await fetchText(url);
      if (!html) continue;
      careersUrl ??= url;
      if (url !== `https://${website}`) careersLike.push(url);
      const board = await boardFromLinks(html, url);
      if (board) return board;
      otherSystem ??= OTHER_SYSTEMS.find(([, re]) => re.test(html))?.[0];
    }
  }
  // 2. The company's name (and website name) on each hiring system.
  for (const slug of slugGuesses(name, website)) {
    for (const system of READABLE) {
      const jobs = await readBoard(system, slug);
      if (jobs && jobs.total > 0) return { system, slug, careersUrl, jobsTotal: jobs.total, jobsInIndia: jobs.inIndia };
    }
  }
  // 3. Firecrawl: the careers page as a browser shows it, and one deeper jobs page if it links one.
  if (website && process.env.FIRECRAWL_API_KEY) {
    const queue = [careersLike[0] ?? `https://${website}/careers`];
    const opened = new Set<string>();
    while (queue.length && opened.size < FIRECRAWL_PAGES) {
      const url = queue.shift()!;
      if (opened.has(url)) continue;
      opened.add(url);
      const links = await firecrawlLinks(url);
      if (!links) continue;
      const text = links.join("\n");
      const board = await boardFromLinks(text, url);
      if (board) return board;
      otherSystem ??= OTHER_SYSTEMS.find(([, re]) => re.test(text))?.[0];
      careersUrl = url;
      const deeper = links
        .map((l) => l.split("#")[0])
        .find((l) => sameSite(l, website) && /job-?openings|open-?positions|openings|\/jobs\b|current-?openings/i.test(l) && !opened.has(l) && l !== url.split("#")[0]);
      if (deeper) queue.push(deeper);
    }
  }
  if (otherSystem) return { system: "other", otherSystem, careersUrl };
  return { system: "none", careersUrl };
}

// A link to a hiring system we can read, in a page's HTML or its list of links. A link on their own
// careers page is their list, even with no openings today.
async function boardFromLinks(text: string, url: string): Promise<Board | null> {
  for (const [system, re] of READABLE_LINKS) {
    const slug = text.match(re)?.[1];
    if (!slug || NOT_A_SLUG.has(slug.toLowerCase())) continue;
    const jobs = await readBoard(system, decodeURIComponent(slug), text);
    if (jobs) return { system, slug: decodeURIComponent(slug), careersUrl: url, jobsTotal: jobs.total, jobsInIndia: jobs.inIndia };
  }
  return null;
}

function sameSite(link: string, website: string): boolean {
  try {
    return new URL(link).hostname.replace(/^www\./, "").endsWith(website);
  } catch {
    return false;
  }
}

// Firecrawl opens the page like a browser (running its JavaScript) and returns every link on it.
// Costs about 1 Firecrawl credit. One page at a time (it turns away too many at once); when it's
// busy anyway, wait and try again. Null if it fails; FirecrawlBusy if it stayed busy.
class FirecrawlBusy extends Error {}
const FIRECRAWL_RETRY_WAITS_MS = [5000, 15000];
let firecrawlQueue: Promise<unknown> = Promise.resolve();

function firecrawlLinks(url: string): Promise<string[] | null> {
  const turn = firecrawlQueue.then(() => firecrawlOnce(url));
  firecrawlQueue = turn.catch(() => null);
  return turn;
}

async function firecrawlOnce(url: string): Promise<string[] | null> {
  try {
    let res: Response | null = null;
    for (const wait of [0, ...FIRECRAWL_RETRY_WAITS_MS]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["links"], onlyMainContent: false, waitFor: 3000 }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status !== 429) break;
    }
    if (res!.status === 429) throw new FirecrawlBusy(url);
    if (!res!.ok) {
      console.warn(`[careers] Firecrawl ${res!.status} for ${url}`);
      return null;
    }
    const res2 = res!;
    const body = (await res2.json()) as { data?: { links?: string[] } };
    console.log(`[careers] Firecrawl read ${url}: ${body.data?.links?.length ?? 0} links`);
    return body.data?.links ?? null;
  } catch (e) {
    if (e instanceof FirecrawlBusy) throw e;
    console.warn(`[careers] Firecrawl failed for ${url}: ${String(e)}`);
    return null;
  }
}

// The homepage, the usual careers addresses, and any "careers"/"jobs" link the homepage has.
async function careersPages(website: string): Promise<string[]> {
  const home = `https://${website}`;
  const pages = new Set<string>();
  const html = await fetchText(home);
  if (html) {
    pages.add(home);
    for (const m of html.matchAll(/href="([^"#]*(?:career|jobs|join-us|work-with-us|hiring)[^"#]*)"/gi)) {
      try {
        const url = new URL(m[1], home);
        if (url.protocol === "https:") pages.add(url.toString());
      } catch {
        // not a usable link
      }
      if (pages.size >= 4) break;
    }
  }
  for (const path of CAREERS_PATHS) pages.add(home + path);
  return [...pages].slice(0, 8);
}

function slugGuesses(name: string, website: string | null): string[] {
  const words = name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  const stem = website?.split(".")[0];
  return [...new Set([words.join(""), words.join("-"), words[0], stem].filter((s): s is string => !!s && s.length > 2))];
}

// Open jobs on a hiring system's public list: how many, and how many are in India. Null if the
// company isn't on it. page: their careers page, which for Keka may hold the list's id.
async function readBoard(system: Readable, slug: string, page?: string): Promise<{ total: number; inIndia: number } | null> {
  const s = encodeURIComponent(slug);
  if (system === "smartrecruiters") return readSmartRecruiters(s);
  if (system === "keka") return readKeka(slug, page);
  const url = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    lever: `https://api.lever.co/v0/postings/${s}?mode=json`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    workable: `https://apply.workable.com/api/v1/widget/accounts/${s}`,
  }[system as "greenhouse" | "lever" | "ashby" | "workable"];
  const text = await fetchText(url);
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const jobs: unknown[] = Array.isArray(data) ? data : ((data as { jobs?: unknown[] })?.jobs ?? []);
  const inIndia = jobs.filter((job) => /india|mumbai|bengaluru|bangalore|delhi|gurgaon|gurugram|noida|pune|hyderabad|chennai|kolkata|ahmedabad/i.test(JSON.stringify(locationOf(job)))).length;
  return { total: jobs.length, inIndia };
}

// SmartRecruiters' official public list. Any name returns a list, and old company pages stay up
// for years, so only jobs posted in the last 90 days count: none means "not on it".
async function readSmartRecruiters(s: string): Promise<{ total: number; inIndia: number } | null> {
  const text = await fetchText(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`);
  let jobs: { releasedDate?: string; location?: { country?: string } }[];
  try {
    jobs = (JSON.parse(text ?? "null") as { content?: typeof jobs } | null)?.content ?? [];
  } catch {
    return null;
  }
  const since = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recent = jobs.filter((j) => j.releasedDate && Date.parse(j.releasedDate) >= since);
  if (!recent.length) return null;
  return { total: recent.length, inIndia: recent.filter((j) => j.location?.country?.toLowerCase() === "in").length };
}

// Keka: the company's careers portal, and the list its careers widget reads. The list needs an id,
// found on the company's own page or in the portal's details.
async function readKeka(sub: string, page?: string): Promise<{ total: number; inIndia: number } | null> {
  if (!/^[a-z0-9-]+$/i.test(sub)) return null;
  const base = `https://${sub}.keka.com/careers/api`;
  const info = await fetchText(`${base}/organization/default/careerportalinfo`);
  if (!info?.trim().startsWith("{")) return null; // no Keka careers portal by that name
  const ids = new Set([...(page ?? "").matchAll(/keka\.com\/careers\/api\/embedjobs\/js\/([0-9a-f-]{36})/gi)].map((m) => m[1]));
  for (const id of info.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) ids.add(id);
  let empty = false;
  for (const id of [...ids].slice(0, 5)) {
    const text = await fetchText(`${base}/embedjobs/default/active/${id}`);
    let jobs: { jobLocations?: { countryCode?: string }[] }[];
    try {
      jobs = JSON.parse(text ?? "null");
    } catch {
      continue;
    }
    if (!Array.isArray(jobs)) continue;
    if (!jobs.length) {
      empty = true; // a wrong id also gives an empty list, so keep trying
      continue;
    }
    return { total: jobs.length, inIndia: jobs.filter((j) => j.jobLocations?.some((l) => l.countryCode === "IN")).length };
  }
  return empty ? { total: 0, inIndia: 0 } : null;
}

// Just the location parts of a job, so a description mentioning "India" doesn't count.
function locationOf(job: unknown): unknown {
  const j = job as Record<string, unknown>;
  return [j.location, j.locationName, j.categories, j.country, j.city, j.state, j.address, j.secondaryLocations];
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > MAX_PAGE_BYTES ? text.slice(0, MAX_PAGE_BYTES) : text;
  } catch {
    return null;
  }
}

export const getBoard = internalQuery({
  args: { key: v.string() },
  returns: v.union(
    v.object({
      system: v.union(v.literal("greenhouse"), v.literal("lever"), v.literal("ashby"), v.literal("workable"), v.literal("smartrecruiters"), v.literal("keka"), v.literal("other"), v.literal("none")),
      slug: v.optional(v.string()),
      otherSystem: v.optional(v.string()),
      careersUrl: v.optional(v.string()),
      jobsTotal: v.optional(v.number()),
      jobsInIndia: v.optional(v.number()),
      checkedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("companyBoards")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!row) return null;
    const { _id, _creationTime, key: _key, name: _name, ...board } = row;
    return board;
  },
});

export const saveBoard = internalMutation({
  args: {
    key: v.string(),
    name: v.string(),
    system: v.union(v.literal("greenhouse"), v.literal("lever"), v.literal("ashby"), v.literal("workable"), v.literal("smartrecruiters"), v.literal("keka"), v.literal("other"), v.literal("none")),
    slug: v.optional(v.string()),
    otherSystem: v.optional(v.string()),
    careersUrl: v.optional(v.string()),
    jobsTotal: v.optional(v.number()),
    jobsInIndia: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("companyBoards")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (row) await ctx.db.replace(row._id, { ...args, checkedAt: Date.now() });
    else await ctx.db.insert("companyBoards", { ...args, checkedAt: Date.now() });
    return null;
  },
});

// For tests: read one company's list on one hiring system.
export const readBoardForTest = internalAction({
  args: { system: v.union(v.literal("smartrecruiters"), v.literal("keka")), slug: v.string() },
  returns: v.union(v.object({ total: v.number(), inIndia: v.number() }), v.null()),
  handler: async (_ctx, { system, slug }) => readBoard(system, slug),
});

// Forget what we found for these companies (by website), so the next run checks them again.
export const forgetBoards = internalMutation({
  args: { keys: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, { keys }) => {
    let n = 0;
    for (const key of keys) {
      const row = await ctx.db
        .query("companyBoards")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (row) {
        await ctx.db.delete(row._id);
        n++;
      }
    }
    return n;
  },
});

// ---------- Reading the jobs, for a user's search ----------

const REFRESH_DAYS = 7; // company lists and job-list locations are looked up again after this
const MAX_DESCRIPTION_CHARS = 6000;

export type CompanyJob = {
  jobId: string; // "keka:jupiter:141185": never clashes with LinkedIn's numbers
  title: string;
  company: string;
  location: string;
  postedOn: string; // YYYY-MM-DD, "" if unknown
  url: string;
  description: string; // "" when it has to be fetched separately (detailUrl)
  detailUrl?: string;
  source: string; // e.g. "PhonePe careers page"
};
const companyJobValidator = v.object({
  jobId: v.string(),
  title: v.string(),
  company: v.string(),
  location: v.string(),
  postedOn: v.string(),
  url: v.string(),
  description: v.string(),
  detailUrl: v.optional(v.string()),
  source: v.string(),
});

// The open jobs at the companies in the user's industries, in their city, posted in the last `days`.
// If an industry's company list is missing or a week old, a background refresh is started (this
// search goes ahead with what's saved).
export const jobsFor = internalAction({
  args: { industries: v.array(v.string()), city: v.string(), days: v.number() },
  returns: v.object({ jobs: v.array(companyJobValidator), companies: v.number(), preparing: v.array(v.string()) }),
  handler: async (ctx, { industries, city, days }) => {
    const places = cityWords(city);
    if (!places.length) return { jobs: [], companies: 0, preparing: [] };
    const preparing: string[] = [];
    const boards = new Map<string, { name: string; system: Readable; slug: string }>();
    for (const industry of industries) {
      const key = `${industry.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
      const list = await ctx.runQuery(internal.companyLists.get, { key });
      if (!list || Date.now() - list.foundAt > REFRESH_DAYS * DAY_MS) {
        if (await ctx.runMutation(internal.companyLists.claimPrepare, { key })) {
          await ctx.scheduler.runAfter(0, internal.careers.prepare, { industry: industry.trim(), city: city.trim() });
        }
        preparing.push(industry);
      }
      for (const company of list?.companies ?? []) {
        const boardKey = company.website ?? company.name.toLowerCase();
        if (boards.has(boardKey)) continue;
        const board = await ctx.runQuery(internal.careers.getBoard, { key: boardKey });
        if (board?.slug && READABLE.includes(board.system as Readable)) boards.set(boardKey, { name: company.name, system: board.system as Readable, slug: board.slug });
      }
    }

    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const jobs: CompanyJob[] = [];
    const all = [...boards.values()];
    for (let i = 0; i < all.length; i += AT_ONCE) {
      const lists = await Promise.all(all.slice(i, i + AT_ONCE).map((b) => listJobs(b.system, b.slug, b.name).catch(() => [])));
      for (const job of lists.flat()) {
        const where = job.location.toLowerCase();
        if (job.postedOn >= cutoff && places.some((p) => where.includes(p))) jobs.push(job);
      }
    }
    return { jobs, companies: boards.size, preparing };
  },
});

// Background: find the companies for an industry and city (1 Claude call, a week at a time), then
// where each lists its jobs (free, plus Firecrawl when needed). Saved as it goes.
export const prepare = internalAction({
  args: { industry: v.string(), city: v.string() },
  returns: v.null(),
  handler: async (ctx, { industry, city }) => {
    const list = await ctx.runAction(internal.companies.findCompanies, { industry, city });
    if (list) await ctx.runAction(internal.careers.findBoards, { industry, city });
    console.log(`[careers] prepared ${industry} in ${city}: ${list?.companies.length ?? 0} companies`);
    return null;
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

// How a city appears in job locations. Empty for "India" or no city: company jobs need a city.
function cityWords(city: string): string[] {
  const c = city.trim().toLowerCase();
  if (!c || c === "india") return [];
  if (/mumbai|bombay/.test(c)) return ["mumbai", "bombay", "thane"];
  if (/bengaluru|bangalore/.test(c)) return ["bengaluru", "bangalore"];
  if (/delhi|ncr/.test(c)) return ["delhi", "gurgaon", "gurugram", "noida"];
  if (/gurgaon|gurugram/.test(c)) return ["gurgaon", "gurugram"];
  return [c.split(",")[0].trim()];
}

const plain = (html: string) =>
  html
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
const day = (when: string | number | undefined | null) => {
  if (when === undefined || when === null || when === "") return "";
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

// One company's open jobs on a hiring system, with what the fit check needs.
async function listJobs(system: Readable, slug: string, company: string): Promise<CompanyJob[]> {
  const s = encodeURIComponent(slug);
  const source = `${company} careers page`;
  const json = async (url: string) => {
    const text = await fetchText(url);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const base = { company, source };
  switch (system) {
    case "greenhouse": {
      const data = await json(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`);
      return (data?.jobs ?? []).map((j: any) => ({
        ...base, jobId: `gh:${slug}:${j.id}`, title: j.title ?? "", location: j.location?.name ?? "",
        postedOn: day(j.first_published ?? j.updated_at), url: j.absolute_url ?? "", description: plain(j.content ?? ""),
      }));
    }
    case "lever": {
      const data = await json(`https://api.lever.co/v0/postings/${s}?mode=json`);
      return (Array.isArray(data) ? data : []).map((j: any) => ({
        ...base, jobId: `lever:${slug}:${j.id}`, title: j.text ?? "",
        location: [j.categories?.location, ...(j.categories?.allLocations ?? [])].filter(Boolean).join("; "),
        postedOn: day(j.createdAt), url: j.hostedUrl ?? "",
        description: plain([j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `${l.text}: ${l.content}`), j.additionalPlain].filter(Boolean).join("\n")),
      }));
    }
    case "ashby": {
      const data = await json(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
      return (data?.jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any) => ({
        ...base, jobId: `ashby:${slug}:${j.id}`, title: j.title ?? "",
        location: [j.location, ...(j.secondaryLocations ?? []).map((l: any) => l.location)].filter(Boolean).join("; "),
        postedOn: day(j.publishedAt), url: j.jobUrl ?? "", description: plain(j.descriptionPlain ?? j.descriptionHtml ?? ""),
      }));
    }
    case "workable": {
      const data = await json(`https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`);
      return (data?.jobs ?? []).map((j: any) => ({
        ...base, jobId: `workable:${slug}:${j.shortcode ?? j.id}`, title: j.title ?? "",
        location: [j.city, j.state, j.country].filter(Boolean).join(", "),
        postedOn: day(j.published_on ?? j.created_at), url: j.url ?? j.shortlink ?? "", description: plain(j.description ?? ""),
      }));
    }
    case "smartrecruiters": {
      const data = await json(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`);
      return (data?.content ?? []).map((j: any) => ({
        ...base, jobId: `sr:${slug}:${j.id}`, title: j.name ?? "",
        location: [j.location?.city, j.location?.region, j.location?.country === "in" ? "India" : j.location?.country].filter(Boolean).join(", "),
        postedOn: day(j.releasedDate), url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        description: "", detailUrl: `https://api.smartrecruiters.com/v1/companies/${s}/postings/${j.id}`,
      }));
    }
    case "keka": {
      const ids = await kekaListIds(slug);
      for (const id of ids) {
        const data = await json(`https://${slug}.keka.com/careers/api/embedjobs/default/active/${id}`);
        if (!Array.isArray(data) || !data.length) continue;
        return data.map((j: any) => ({
          ...base, jobId: `keka:${slug}:${j.id}`, title: j.title ?? "",
          location: (j.jobLocations ?? []).map((l: any) => [l.city, l.countryName].filter(Boolean).join(", ")).join("; "),
          postedOn: day(j.publishedOn), url: `https://${slug}.keka.com/careers/jobdetails/${j.id}`, description: plain(j.description ?? ""),
        }));
      }
      return [];
    }
  }
}

async function kekaListIds(sub: string): Promise<string[]> {
  if (!/^[a-z0-9-]+$/i.test(sub)) return [];
  const info = await fetchText(`https://${sub}.keka.com/careers/api/organization/default/careerportalinfo`);
  return [...new Set(info?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])].slice(0, 5);
}

// A SmartRecruiters job's full text, from its detail page (fetched only for jobs Claude will check).
export async function smartRecruitersDescription(url: string): Promise<string> {
  const text = await fetchText(url);
  try {
    const sections = (JSON.parse(text ?? "null") as { jobAd?: { sections?: Record<string, { title?: string; text?: string }> } } | null)?.jobAd?.sections ?? {};
    return plain(Object.values(sections).map((s) => `${s.title ?? ""}\n${s.text ?? ""}`).join("\n"));
  } catch {
    return "";
  }
}
