"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// Milestone 1: find Senior PM jobs on LinkedIn's public (no-login) job search,
// check each against the saved resume with Claude, and return the ones that fit.
// Run from the terminal:  npx convex run jobs:findMatches

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const JOB_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const PAGE_SIZE = 10; // LinkedIn returns 10 cards per page
const MAX_PAGES = 3; // keep requests to LinkedIn low
const PAUSE_MS = 1500; // wait between LinkedIn requests
const CLAUDE_CONCURRENCY = 5;

// Titles that are clearly a PM role, and words that mean it's the wrong level or a different job.
const PM_TITLE = /product (manager|lead|head)|head of product|group product|principal product/i;
const WRONG_TITLE = /associate|junior|\bjr\b|intern|analyst|apm\b|marketing|project manager|program manager/i;

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

const FitSchema = z.object({
  fit: z.enum(["strong", "partial", "not_a_fit"]),
  reason: z.string(),
  caveat: z.string().nullable(),
});

const SYSTEM_PROMPT = `You screen job postings for one candidate. You get the candidate's resume and one job description.

Decide how well the job fits the candidate:
- "strong": seniority matches (Senior PM level, roughly 8-14 years), and the candidate's domain, product type, and skills clearly line up with what the job asks for.
- "partial": the level fits, but there's a real gap (different domain, missing a must-have skill, slightly too junior or senior). Still worth a look.
- "not_a_fit": wrong level, wrong function, or the must-haves clearly don't match the resume.

reason: one plain-English line, under 25 words, saying why. Name the specific overlap or gap (e.g. "B2B SaaS + risk products match; JD wants fintech payments, which the resume doesn't show").
caveat: one short line if something needs flagging (e.g. "JD asks for 15+ years", "role may be hybrid in Pune"), otherwise null.
Judge only from the resume and job description given. Don't invent facts about the candidate.`;

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
  handler: async (ctx, args) => {
    const keywords = args.keywords ?? "Senior Product Manager";
    const location = args.location ?? "Mumbai, Maharashtra, India";
    const days = args.days ?? 7;
    const search = `"${keywords}" in ${location}, last ${days} days`;

    const resume = await ctx.runQuery(internal.profile.getResume, {});
    if (!resume) {
      throw new Error("No resume saved yet. Run profile:setResume first.");
    }

    // 1. Fetch job cards from LinkedIn's public search, a few pages at most.
    const cards: Card[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        keywords,
        location,
        f_TPR: `r${days * 24 * 60 * 60}`,
        start: String(page * PAGE_SIZE),
      });
      const html = await fetchText(`${SEARCH_URL}?${params}`);
      const pageCards = parseCards(html);
      cards.push(...pageCards);
      if (pageCards.length < PAGE_SIZE) break;
      await sleep(PAUSE_MS);
    }

    // 2. Drop old postings, non-PM titles, and duplicates (same id, or same title + company).
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const seen = new Set<string>();
    let tooOld = 0;
    let wrongTitle = 0;
    let duplicates = 0;
    const candidates: Card[] = [];
    for (const card of cards) {
      const key = `${card.title}|${card.company}`.toLowerCase();
      if (seen.has(card.jobId) || seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(card.jobId);
      seen.add(key);
      if (!card.postedOn || card.postedOn < cutoff) {
        tooOld++;
        continue;
      }
      if (!PM_TITLE.test(card.title) || WRONG_TITLE.test(card.title)) {
        wrongTitle++;
        continue;
      }
      candidates.push(card);
    }

    // 3. Read each remaining job's full description, one at a time.
    const descriptions = new Map<string, string>();
    for (const card of candidates) {
      try {
        descriptions.set(card.jobId, parseDescription(await fetchText(JOB_URL + card.jobId)));
      } catch (e) {
        console.warn(`Couldn't read job ${card.jobId}: ${String(e)}`);
      }
      await sleep(PAUSE_MS);
    }

    // 4. Ask Claude how well each job fits the resume.
    const client = new Anthropic();
    const verdicts = new Map<string, z.infer<typeof FitSchema>>();
    const checkFit = async (card: Card) => {
      const jd = descriptions.get(card.jobId);
      if (!jd) return;
      try {
        const response = await client.messages.parse({
          model: "claude-opus-5-5",
          max_tokens: 4000,
          output_config: { effort: "low", format: zodOutputFormat(FitSchema) },
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `<resume>\n${resume}\n</resume>\n\n<job>\nTitle: ${card.title}\nCompany: ${card.company}\nLocation: ${card.location}\n\n${jd}\n</job>`,
            },
          ],
        });
        if (response.stop_reason === "refusal" || !response.parsed_output) {
          console.warn(`No verdict for job ${card.jobId} (stop: ${response.stop_reason})`);
          return;
        }
        verdicts.set(card.jobId, response.parsed_output);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Convex settings.");
        console.warn(`Fit check failed for job ${card.jobId}: ${String(e)}`);
      }
    };
    for (let i = 0; i < candidates.length; i += CLAUDE_CONCURRENCY) {
      await Promise.all(candidates.slice(i, i + CLAUDE_CONCURRENCY).map(checkFit));
    }

    // 5. Keep strong and partial fits, newest first, strong before partial on the same day.
    const matches = candidates
      .flatMap((card) => {
        const verdict = verdicts.get(card.jobId);
        if (!verdict || verdict.fit === "not_a_fit") return [];
        return [{
          title: card.title,
          company: card.company,
          location: card.location,
          postedOn: card.postedOn,
          fit: verdict.fit,
          reason: verdict.reason,
          caveat: verdict.caveat,
          url: card.url,
        }];
      })
      .sort((a, b) =>
        b.postedOn.localeCompare(a.postedOn) || (a.fit === "strong" ? -1 : 1) - (b.fit === "strong" ? -1 : 1),
      );

    const notAFit = [...verdicts.values()].filter((x) => x.fit === "not_a_fit").length;
    const unchecked = candidates.length - verdicts.size;
    let summary =
      `LinkedIn returned ${cards.length} jobs. Dropped: ${tooOld} older than ${days} days, ` +
      `${wrongTitle} not a senior PM title, ${duplicates} duplicates, ${notAFit} not a real fit` +
      (unchecked ? `, ${unchecked} couldn't be checked` : "") +
      `. ${matches.length} left.`;
    if (matches.length === 0) {
      summary +=
        " Nothing matched this time. Try a wider window (days: 14) or tell me another public job site to search.";
    }

    return { search, summary, matches };
  },
});
