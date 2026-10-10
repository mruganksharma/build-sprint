"use node";

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { type Infer, v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { rateLimiter } from "./limits";

// Find jobs on LinkedIn's public (no-login) job search, check each against a resume with Claude,
// and keep the ones that fit.
//   Milestone 1 (owner, terminal):  npx convex run jobs:findMatches
//   Milestone 4a (WhatsApp users):  jobs:searchForUser, results sent in the chat

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const JOB_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const PAGE_SIZE = 10; // LinkedIn returns 10 cards per page
const MAX_PAGES = 3; // keep requests to LinkedIn low
const PAUSE_MS = 1500; // wait between LinkedIn requests
const CLAUDE_CONCURRENCY = 5;
const MAX_SHOWN = 10; // jobs per WhatsApp reply
const MAX_CHECKS = 10; // most jobs Claude checks per search (newest first), to keep the hourly limit
const REUSE_DAYS = 7; // reuse Claude's verdict on a job judged this recently for the same user
const MAX_MESSAGE_CHARS = 3500; // WhatsApp allows 4096; leave room

// Product roles keep the original title rules: clearly a PM role, and not the wrong level or job.
const PM_TITLE = /product (manager|lead|head)|head of product|group product|principal product/i;
const WRONG_PM_TITLE = /associate|junior|\bjr\b|intern|analyst|apm\b|marketing|project manager|program manager/i;
// Other roles: the title must share a real word with the role searched for, and not be entry level.
const GENERIC_WORDS = new Set(["senior", "sr", "lead", "principal", "staff", "head", "chief", "of", "and", "the", "manager", "director", "vp", "i", "ii", "iii"]);
const ENTRY_LEVEL = /\bintern|junior|\bjr\b|trainee|fresher|graduate/i;

// LinkedIn understands these better than the short names people type.
const LINKEDIN_LOCATIONS: Record<string, string> = {
  mumbai: "Mumbai, Maharashtra, India",
  "delhi ncr": "Delhi, India",
  delhi: "Delhi, India",
  bengaluru: "Bengaluru, Karnataka, India",
  bangalore: "Bengaluru, Karnataka, India",
  hyderabad: "Hyderabad, Telangana, India",
  chennai: "Chennai, Tamil Nadu, India",
  pune: "Pune, Maharashtra, India",
  kolkata: "Kolkata, West Bengal, India",
  ahmedabad: "Ahmedabad, Gujarat, India",
};

type Card = {
  jobId: string;
  title: string;
  company: string;
  location: string;
  postedOn: string; // YYYY-MM-DD
  url: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(html: string, re: RegExp): string {
  const m = html.match(re);
  return m ? decode(m[1]) : "";
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`LinkedIn returned ${res.status} for ${url}`);
  return res.text();
}

function parseCards(html: string): Card[] {
  const cards: Card[] = [];
  for (const block of html.split("<li>").slice(1)) {
    const jobId = pick(block, /urn:li:jobPosting:(\d+)/);
    if (!jobId) continue;
    const href = pick(block, /base-card__full-link[^>]*href="([^"?]+)/);
    cards.push({
      jobId,
      title: pick(block, /base-search-card__title">([\s\S]*?)<\/h3>/),
      company: pick(block, /base-search-card__subtitle">([\s\S]*?)<\/h4>/),
      location: pick(block, /job-search-card__location">([\s\S]*?)<\/span>/),
      postedOn: pick(block, /datetime="([^"]+)"/),
      url: href || `https://www.linkedin.com/jobs/view/${jobId}`,
    });
  }
  return cards;
}

function parseDescription(html: string): string {
  const desc = pick(html, /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
  const seniority = pick(
    html,
    /Seniority level\s*<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/,
  );
  return (seniority ? `LinkedIn seniority level: ${seniority}\n\n` : "") + desc;
}

// Which job titles are worth reading, for the role being searched.
function titleFilter(role: string): (title: string) => boolean {
  if (/product/i.test(role)) return (title) => PM_TITLE.test(title) && !WRONG_PM_TITLE.test(title);
  const words = role
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 1 && !GENERIC_WORDS.has(w));
  return (title) => {
    const t = title.toLowerCase();
    return !ENTRY_LEVEL.test(t) && (words.length === 0 || words.some((w) => t.includes(w)));
  };
}

export function linkedinLocation(place: string): string {
  return LINKEDIN_LOCATIONS[place.trim().toLowerCase()] ?? (place.includes(",") ? place : `${place}, India`);
}

const FitSchema = z.object({
  fit: z.enum(["strong", "partial", "not_a_fit"]),
  reason: z.string(),
  caveat: z.string().nullable(),
  brokenPreference: z.string().nullable(),
});
type Verdict = z.infer<typeof FitSchema>;

const SYSTEM_PROMPT = `You screen job postings for one candidate. You get the candidate's resume and one job description.

Decide how well the job fits the candidate:
- "strong": the seniority matches the candidate's level (judge from the years and titles on the resume), and their domain, product or work type, and skills clearly line up with what the job asks for.
- "partial": the level fits, but there's a real gap (different domain, missing a must-have skill, slightly too junior or senior). Still worth a look.
- "not_a_fit": wrong level, wrong function, or the must-haves clearly don't match the resume.

reason: one plain-English line, under 25 words, saying why. Name the specific overlap or gap (e.g. "B2B SaaS + risk products match; JD wants fintech payments, which the resume doesn't show").
caveat: one short line if something needs flagging (e.g. "JD asks for 15+ years", "role may be hybrid in Pune"), otherwise null.
Judge only from the resume and job description given. Don't invent facts about the candidate. No personal comments about the candidate.

The candidate may also give preferences. Treat them as hard rules: if the job clearly breaks any one of them, fit is "not_a_fit" and brokenPreference names the rule in a few words (e.g. "avoid banks: this is a bank"). If it breaks none, or there are no preferences, brokenPreference is null. Preferences never make a job a better fit than the resume supports.

The preferences may also list jobs the candidate said they want more of, or don't want more of. These are not hard rules: if a job is very much like one they don't want, rate it "not_a_fit" and say so in the reason; use jobs they want more of only to choose between "strong" and "partial" when the resume supports either.`;

const matchValidator = v.object({
  title: v.string(),
  company: v.string(),
  location: v.string(),
  postedOn: v.string(),
  fit: v.union(v.literal("strong"), v.literal("partial")),
  reason: v.string(),
  caveat: v.union(v.string(), v.null()),
  url: v.string(),
});
type Match = Infer<typeof matchValidator>;

// What happened to every job LinkedIn returned, so it can be explained later.
export type Outcome = "too_old" | "wrong_title" | "duplicate" | "unreadable" | "unchecked" | "not_a_fit" | "broke_preference" | "shown" | "already_sent" | "not_checked";
type PriorVerdict = Verdict & { outcome: Outcome };
type MatchWithId = Match & { jobId: string };
export type JobRecord = Card & { outcome: Outcome; fit?: Verdict["fit"]; reason?: string; caveat?: string | null; brokenPreference?: string | null };

type SearchResult = {
  search: string;
  summary: string;
  matches: MatchWithId[];
  records: JobRecord[];
  counts: { returned: number; tooOld: number; wrongTitle: number; duplicates: number; notAFit: number; brokePreference: number; unchecked: number; alreadySent: number; notChecked: number };
  days: number;
};

type Preferences = NonNullable<Doc<"profile">["preferences"]>;

function preferenceRules(prefs: Preferences | null) {
  const rules = [
    prefs?.industries?.length ? `Job must be in one of these industries: ${prefs.industries.join(", ")}` : null,
    prefs?.avoid?.length ? `Avoid these industries or companies: ${prefs.avoid.join(", ")}` : null,
    ...(prefs?.mustHaves ?? []).map((rule) => `Must have: ${rule}`),
  ].filter((rule): rule is string => rule !== null);
  const soft = [
    prefs?.likes?.length ? `Wants more jobs like: ${prefs.likes.join("; ")}` : null,
    prefs?.dislikes?.length ? `Doesn't want jobs like: ${prefs.dislikes.join("; ")}` : null,
  ].filter((line): line is string => line !== null);
  const lines = [...rules, ...soft];
  const block = lines.length ? `\n\n<preferences>\n${lines.map((line) => `- ${line}`).join("\n")}\n</preferences>` : "";
  return { hasRules: rules.length > 0, block };
}

// Asks Claude how well one job fits. Returns null if it couldn't (hourly limit, refusal, error).
async function checkFit(ctx: ActionCtx, client: Anthropic, resume: string, card: Pick<Card, "jobId" | "title" | "company" | "location">, jd: string, preferencesBlock: string): Promise<Verdict | null> {
  const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
  if (!ok) {
    console.warn(`Hourly Claude limit reached; skipped job ${card.jobId}`);
    return null;
  }
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(FitSchema) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `<resume>\n${resume}\n</resume>\n\n<job>\nTitle: ${card.title}\nCompany: ${card.company}\nLocation: ${card.location}\n\n${jd}\n</job>${preferencesBlock}`,
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.warn(`No verdict for job ${card.jobId} (stop: ${response.stop_reason})`);
      return null;
    }
    return response.parsed_output;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Convex settings.");
    console.warn(`Fit check failed for job ${card.jobId}: ${String(e)}`);
    return null;
  }
}

async function runSearch(
  ctx: ActionCtx,
  opts: { resume: string; prefs: Preferences | null; role: string; location: string; days: number; prior?: Map<string, PriorVerdict> },
): Promise<SearchResult> {
  const { resume, prefs, role, location, days, prior = new Map() } = opts;

  // One LinkedIn search per wanted industry (e.g. "Senior Product Manager B2B SaaS"), else just the role.
  const queries = prefs?.industries?.length ? prefs.industries.map((industry) => `${role} ${industry}`) : [role];
  const pagesPerQuery = Math.max(1, Math.floor(MAX_PAGES / queries.length));
  const search = `${queries.map((q) => `"${q}"`).join(" + ")} in ${location}, last ${days} days`;

  const { hasRules, block: preferencesBlock } = preferenceRules(prefs);

  // 1. Fetch job cards from LinkedIn's public search, a few pages at most.
  const cards: Card[] = [];
  for (const query of queries) {
    for (let page = 0; page < pagesPerQuery; page++) {
      const params = new URLSearchParams({
        keywords: query,
        location,
        f_TPR: `r${days * 24 * 60 * 60}`,
        start: String(page * PAGE_SIZE),
      });
      const html = await fetchText(`${SEARCH_URL}?${params}`);
      const pageCards = parseCards(html);
      cards.push(...pageCards);
      await sleep(PAUSE_MS);
      if (pageCards.length < PAGE_SIZE) break;
    }
  }

  // 2. Drop old postings, wrong titles, and duplicates (same id, or same title + company).
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const titleOk = titleFilter(role);
  const seen = new Set<string>();
  const records: JobRecord[] = [];
  const candidates: Card[] = [];
  for (const card of cards) {
    const key = `${card.title}|${card.company}`.toLowerCase();
    if (seen.has(card.jobId) || seen.has(key)) {
      records.push({ ...card, outcome: "duplicate" });
      continue;
    }
    seen.add(card.jobId);
    seen.add(key);
    if (!card.postedOn || card.postedOn < cutoff) records.push({ ...card, outcome: "too_old" });
    else if (!titleOk(card.title)) records.push({ ...card, outcome: "wrong_title" });
    else candidates.push(card);
  }

  // Jobs Claude judged for this user recently: reuse the verdict. Ones already sent aren't sent again.
  // Of the rest, Claude checks only the newest few.
  const fresh: Card[] = [];
  for (const card of candidates) {
    const before = prior.get(card.jobId);
    if (!before) fresh.push(card);
    else records.push({ ...card, ...before, outcome: before.outcome === "shown" || before.outcome === "already_sent" ? "already_sent" : before.outcome });
  }
  fresh.sort((a, b) => b.postedOn.localeCompare(a.postedOn));
  const toCheck = fresh.slice(0, MAX_CHECKS);
  for (const card of fresh.slice(MAX_CHECKS)) records.push({ ...card, outcome: "not_checked" });

  // 3. Read each job's full description, one at a time.
  const descriptions = new Map<string, string>();
  for (const card of toCheck) {
    try {
      descriptions.set(card.jobId, parseDescription(await fetchText(JOB_URL + card.jobId)));
    } catch (e) {
      console.warn(`Couldn't read job ${card.jobId}: ${String(e)}`);
    }
    await sleep(PAUSE_MS);
  }

  // 4. Ask Claude how well each job fits the resume.
  const client = new Anthropic();
  const verdicts = new Map<string, Verdict>();
  const checkOne = async (card: Card) => {
    const jd = descriptions.get(card.jobId);
    if (!jd) return;
    const verdict = await checkFit(ctx, client, resume, card, jd, preferencesBlock);
    if (verdict) verdicts.set(card.jobId, verdict);
  };
  for (let i = 0; i < toCheck.length; i += CLAUDE_CONCURRENCY) {
    await Promise.all(toCheck.slice(i, i + CLAUDE_CONCURRENCY).map(checkOne));
  }

  // 5. Keep strong and partial fits, newest first, strong before partial on the same day.
  const matches: MatchWithId[] = [];
  for (const card of toCheck) {
    const verdict = verdicts.get(card.jobId);
    if (!verdict) {
      records.push({ ...card, outcome: descriptions.has(card.jobId) ? "unchecked" : "unreadable" });
      continue;
    }
    const outcome: Outcome = verdict.brokenPreference ? "broke_preference" : verdict.fit === "not_a_fit" ? "not_a_fit" : "shown";
    records.push({ ...card, ...verdict, outcome });
    if (outcome !== "shown" || verdict.fit === "not_a_fit") continue;
    matches.push({
      jobId: card.jobId,
      title: card.title,
      company: card.company,
      location: card.location,
      postedOn: card.postedOn,
      fit: verdict.fit,
      reason: verdict.reason,
      caveat: verdict.caveat,
      url: card.url,
    });
  }
  matches.sort(
    (a, b) => b.postedOn.localeCompare(a.postedOn) || (a.fit === "strong" ? -1 : 1) - (b.fit === "strong" ? -1 : 1),
  );

  const count = (o: Outcome) => records.filter((r) => r.outcome === o).length;
  const counts = {
    returned: cards.length,
    tooOld: count("too_old"),
    wrongTitle: count("wrong_title"),
    duplicates: count("duplicate"),
    notAFit: count("not_a_fit"),
    brokePreference: count("broke_preference"),
    unchecked: count("unchecked") + count("unreadable"),
    alreadySent: count("already_sent"),
    notChecked: count("not_checked"),
  };
  let summary =
    `LinkedIn returned ${counts.returned} jobs. Dropped: ${counts.tooOld} older than ${days} days, ` +
    `${counts.wrongTitle} wrong job title, ${counts.duplicates} duplicates, ` +
    (hasRules ? `${counts.brokePreference} broke your preferences, ` : "") +
    `${counts.notAFit} not a real fit` +
    (counts.unchecked ? `, ${counts.unchecked} couldn't be checked` : "") +
    (counts.alreadySent ? `, ${counts.alreadySent} already sent recently` : "") +
    (counts.notChecked ? `, ${counts.notChecked} not checked (only the newest ${MAX_CHECKS} are)` : "") +
    `. ${matches.length} left.`;
  if (matches.length === 0) {
    summary += " Nothing matched this time. Try a wider window (days: 14) or tell me another public job site to search.";
  }
  return { search, summary, matches, records, counts, days };
}

// Milestone 1: the owner's own search, run from the terminal.
export const findMatches = internalAction({
  args: {
    keywords: v.optional(v.string()),
    location: v.optional(v.string()),
    days: v.optional(v.number()),
  },
  returns: v.object({
    search: v.string(),
    summary: v.string(),
    matches: v.array(matchValidator),
  }),
  handler: async (ctx, args): Promise<{ search: string; summary: string; matches: Match[] }> => {
    const prefs: Doc<"profile">["preferences"] | null = await ctx.runQuery(internal.profile.getPreferences, {});
    const resume: string | null = await ctx.runQuery(internal.profile.getResume, {});
    if (!resume) {
      throw new Error("No resume saved yet. Run profile:setResume first.");
    }
    const { search, summary, matches: found } = await runSearch(ctx, {
      resume,
      prefs: prefs ?? null,
      role: args.keywords ?? prefs?.role ?? "Senior Product Manager",
      location: args.location ?? prefs?.location ?? "Mumbai, Maharashtra, India",
      days: args.days ?? prefs?.days ?? 7,
    });
    const matches = found.map(({ jobId: _, ...match }) => match);
    return { search, summary, matches };
  },
});

// ---------- Milestone 4a: search for a WhatsApp user and send the results in the chat ----------

const send = (ctx: ActionCtx, to: string, text: string) => ctx.runAction(internal.whatsapp.sendReply, { to, text });

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function formatJob(job: Match, n: number): string {
  const jobId = job.url.match(/(\d{6,})(?:\/?$|\?)/)?.[1];
  const link = jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : job.url;
  return [
    `${n}. ${job.title} – ${job.company}`,
    `${job.location} · posted ${formatDate(job.postedOn)} · ${job.fit === "strong" ? "Strong fit" : "Partial fit"}`,
    `Why: ${job.reason}`,
    job.caveat ? `Note: ${job.caveat}` : null,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

// Splits the list into WhatsApp-sized messages without cutting a job in half.
function chunk(parts: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length + 2 > MAX_MESSAGE_CHARS) {
      out.push(current);
      current = part;
    } else {
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) out.push(current);
  return out;
}

const daysText = (days: number) => (days === 1 ? "the last 24 hours" : `the last ${days} days`);

const AFTER_RESULTS =
  "Tell me which ones you like: reply with a job number and yes or no, e.g. '3 no'. Reply 'jobs' to search again, or 'change' to update what you're looking for.";
const PORTAL_QUESTION =
  "Is there another job site you'd like me to search? Reply with its name, e.g. Naukri. I can only search LinkedIn today, but I'll note it.";

// Same resume and same hard preferences → Claude's earlier verdicts still hold. Likes and dislikes
// are left out on purpose: they nudge new checks but don't make old verdicts wrong.
function matchKey(resume: string, role: string, prefs: Preferences | null): string {
  const { industries, avoid, mustHaves, location, days } = prefs ?? {};
  return createHash("sha256").update(JSON.stringify({ resume, role, industries, avoid, mustHaves, location, days })).digest("hex").slice(0, 16);
}

export const searchForUser = internalAction({
  args: { phone: v.string(), announce: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { phone, announce }) => {
    // Dev-only switch so tests of the questions don't each run a real search. Never set in production.
    if (process.env.JOB_SEARCH === "off") {
      console.log(`[jobs] JOB_SEARCH=off; skipped search for ${phone}`);
      return null;
    }
    const profile = await ctx.runQuery(internal.profile.getForSearch, { phone });
    if (!profile || !profile.ready) {
      await send(ctx, phone, "Send me your resume first, and I'll find jobs that fit you.");
      return null;
    }
    if (!(await ctx.runMutation(internal.profile.startSearch, { phone }))) {
      await send(ctx, phone, "I'm still searching. Your jobs will arrive here in a minute or two.");
      return null;
    }
    const prefs = profile.preferences;
    const place = prefs?.location ?? "India";
    const industries = prefs?.industries?.length ? `${prefs.industries.join(", ")} ` : "";
    try {
      if (announce) {
        await send(ctx, phone, `Searching LinkedIn for ${industries}jobs in ${place}. This takes a couple of minutes.`);
      }
      const role = profile.role ?? "jobs";
      const key = matchKey(profile.resumeText, role, prefs);
      const recent = await ctx.runQuery(internal.history.recentVerdicts, {
        phone,
        matchKey: key,
        since: Date.now() - REUSE_DAYS * 24 * 60 * 60 * 1000,
      });
      const result = await runSearch(ctx, {
        resume: profile.resumeText,
        prefs,
        role,
        location: linkedinLocation(place),
        days: prefs?.days ?? 7,
        prior: new Map(recent.map(({ jobId, ...verdict }) => [jobId, verdict])),
      });
      const shown = result.matches.slice(0, MAX_SHOWN);
      await ctx.runMutation(internal.history.saveSearch, {
        phone,
        search: result.search,
        summary: result.summary,
        shown: shown.map((job) => job.jobId),
        matchKey: key,
        jobs: result.records.map((r) => ({
          jobId: r.jobId,
          title: r.title,
          company: r.company,
          location: r.location,
          postedOn: r.postedOn,
          url: r.url,
          outcome: r.outcome,
          fit: r.fit,
          reason: r.reason,
          caveat: r.caveat ?? undefined,
          brokenPreference: r.brokenPreference ?? undefined,
        })),
      });

      const { matches, counts, days } = result;
      if (matches.length === 0) {
        const why = [
          counts.wrongTitle && `${counts.wrongTitle} were a different role`,
          counts.notAFit && `${counts.notAFit} didn't fit your experience`,
          counts.brokePreference && `${counts.brokePreference} were outside what you asked for`,
          counts.tooOld && `${counts.tooOld} were older than ${days === 1 ? "24 hours" : `${days} days`}`,
          counts.unchecked && `${counts.unchecked} I couldn't check right now`,
          counts.alreadySent && `${counts.alreadySent} I've already sent you`,
          counts.notChecked && `${counts.notChecked} I'll check next time`,
        ].filter(Boolean);
        const nothing =
          counts.returned === 0
            ? `LinkedIn had no ${industries}jobs for your role in ${place} from ${daysText(days)}. Reply 'change' to try a different industry or city.`
            : `I checked ${counts.returned} jobs on LinkedIn in ${place} from ${daysText(days)}, but found nothing new that fits` +
              (why.length ? ` (${why.join(", ")})` : "") +
              ". Reply 'change' to try a different industry or city, or 'jobs' to try again later.";
        const askSite = await ctx.runMutation(internal.chat.askPortal, { phone });
        await send(ctx, phone, askSite ? `${nothing}\n\n${PORTAL_QUESTION}` : nothing);
        return null;
      }
      const header =
        `Found ${matches.length} new job${matches.length === 1 ? "" : "s"} for you on LinkedIn, newest first` +
        (matches.length > MAX_SHOWN ? ` (showing the top ${MAX_SHOWN})` : "") +
        (counts.alreadySent ? `. I've left out ${counts.alreadySent} I sent you before` : "") +
        ":";
      for (const message of chunk([header, ...shown.map((job, i) => formatJob(job, i + 1)), AFTER_RESULTS])) {
        await send(ctx, phone, message);
      }
    } catch (e) {
      console.warn(`[jobs] search failed for ${phone}: ${String(e)}`);
      await send(ctx, phone, "I couldn't reach LinkedIn right now. Reply 'jobs' in a few minutes to try again.");
    } finally {
      await ctx.runMutation(internal.profile.finishSearch, { phone });
    }
    return null;
  },
});

// ---------- Milestone 4b: "why didn't you show me this job?" ----------

const fitLabel = { strong: "Strong fit", partial: "Partial fit", not_a_fit: "Not a fit" } as const;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

// Explains a LinkedIn job the user sent: what our searches did with it and why, plus how it fits
// them now. Then asks whether they want more jobs like it.
export const explainJob = internalAction({
  args: { phone: v.string(), jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone, jobId }) => {
    const profile = await ctx.runQuery(internal.profile.getForSearch, { phone });
    if (!profile) {
      await send(ctx, phone, "Send me your resume first, then I can tell you how this job fits you.");
      return null;
    }
    const seen = await ctx.runQuery(internal.history.findJob, { phone, jobId });
    const lines: string[] = [];
    let title = seen?.title ?? "";
    let company = seen?.company ?? "";
    const name = () => `${title} – ${company}`;

    // 1. What our searches did with it.
    let needsCheck = true;
    if (seen) {
      const when = day(seen.seenOn);
      if (seen.outcome === "shown") {
        lines.push(`I sent you this one on ${when}: ${name()}, ${fitLabel[seen.fit ?? "partial"]}.\nWhy: ${seen.reason}`);
        needsCheck = false;
      } else if (seen.outcome === "not_a_fit" && seen.reason) {
        lines.push(`I looked at ${name()} on ${when} and left it out: ${seen.reason}`);
        needsCheck = false;
      } else if (seen.outcome === "broke_preference") {
        lines.push(`I left out ${name()} on ${when} because it's outside what you asked for: ${seen.brokenPreference}.`);
        needsCheck = false;
      } else if (seen.outcome === "too_old") {
        lines.push(`I left out ${name()} because it was posted on ${formatDate(seen.postedOn)}, before the days I search.`);
      } else if (seen.outcome === "wrong_title") {
        lines.push(`I left out ${name()} because its title didn't match the role I search for (${profile.role ?? "your role"}).`);
      } else {
        lines.push(`I found ${name()} on ${when} but couldn't check it properly then.`);
      }
    } else {
      lines.push("That job didn't come up in my searches.");
    }

    // 2. If we never judged it, judge it now.
    if (needsCheck) {
      try {
        const html = await fetchText(JOB_URL + jobId);
        title ||= pick(html, /top-card-layout__title[^>]*>([\s\S]*?)<\/h[12]>/) || "This job";
        company ||= pick(html, /topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/) || "unknown company";
        const location = pick(html, /topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/);
        const { block } = preferenceRules(profile.preferences);
        const verdict = await checkFit(ctx, new Anthropic(), profile.resumeText, { jobId, title, company, location }, parseDescription(html), block);
        if (!verdict) {
          lines.push("I can't check how it fits you right now. Send it again in a few minutes.");
        } else {
          lines.push(
            [
              `Here's how ${name()} fits you: ${fitLabel[verdict.fit]}.`,
              `Why: ${verdict.reason}`,
              verdict.brokenPreference ? `It's outside what you asked for: ${verdict.brokenPreference}.` : null,
              verdict.caveat ? `Note: ${verdict.caveat}` : null,
            ].filter(Boolean).join("\n"),
          );
        }
      } catch (e) {
        console.warn(`[jobs] couldn't open job ${jobId}: ${String(e)}`);
        lines.push("I couldn't open that job on LinkedIn. It may have closed.");
        await send(ctx, phone, lines.join("\n\n"));
        return null;
      }
    }

    // 3. Learn from it: only when they're not in the middle of the questions.
    const asked = profile.ready && (await ctx.runMutation(internal.chat.askJobFeedback, { phone, job: `${title} at ${company}` }));
    if (asked) lines.push("Do you want more jobs like this one?\n1. Yes\n2. No");
    await send(ctx, phone, lines.join("\n\n"));
    return null;
  },
});
