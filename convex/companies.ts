"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { rateLimiter } from "./limits";

// A second source of jobs, independent of LinkedIn. Step 1: for an industry and city, find the
// companies there. Claude lists them from its own knowledge, then checks and adds to the list with
// web search. The list is saved and shared by every user; each weekly refresh adds new companies
// (see companyLists.save). careers.ts finds where each company lists its jobs and reads them.
//
// Try it from the terminal:
//   npx convex run companies:findCompanies '{"industry": "Fintech", "city": "Mumbai"}'

const KEEP_DAYS = 7;
const MAX_SEARCHES = 5; // web searches Claude may run per list
const MAX_COMPANIES = 40;
const MAX_TURNS = 4; // a long web search can pause; carry on at most this many times

const companySchema = z.object({ name: z.string(), website: z.string().nullable() });
const CompanyList = z.object({ companies: z.array(companySchema), closed: z.array(z.string()) });
type Company = z.infer<typeof companySchema>;

const SYSTEM_PROMPT = `You build a list of companies for a job-finding app in India. Given an industry and a city, list the companies in that industry that have an office or team in that city and hire there.

First write down the companies you already know. Then use web search to check that list and add to it: recent startups and companies that have grown or opened offices there lately, and drop any that have shut down, been bought and folded in, or left that city.

For each company:
name: its usual name, e.g. "Razorpay".
website: its main website domain, e.g. "razorpay.com", or null if you're not sure.

Up to ${MAX_COMPANIES} companies, the best-known and largest employers first. Only real companies you are confident about; never make one up.

You may also get the companies already on our list. Then list only companies NOT already on it, and in "closed" name any listed company you're confident has shut down, been bought and folded into another, or left that city (else an empty list).`;

export const findCompanies = internalAction({
  args: { industry: v.string(), city: v.string(), refresh: v.optional(v.boolean()) },
  returns: v.union(
    v.object({ companies: v.array(v.object({ name: v.string(), website: v.union(v.string(), v.null()) })), fromSaved: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, { industry, city, refresh }): Promise<{ companies: Company[]; fromSaved: boolean } | null> => {
    const key = `${industry.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
    const saved: { companies: Company[]; foundAt: number } | null = await ctx.runQuery(internal.companyLists.get, { key });
    if (saved && !refresh && Date.now() - saved.foundAt < KEEP_DAYS * 24 * 60 * 60 * 1000) {
      return { companies: saved.companies, fromSaved: true };
    }

    const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
    if (!ok) return saved ? { companies: saved.companies, fromSaved: true } : null;
    const found = await askClaude(industry.trim(), city.trim(), saved?.companies.map((c) => c.name) ?? []);
    if (!found) return saved ? { companies: saved.companies, fromSaved: true } : null;
    await ctx.runMutation(internal.companyLists.save, { key, industry: industry.trim(), city: city.trim(), ...found });
    const list: { companies: Company[] } | null = await ctx.runQuery(internal.companyLists.get, { key });
    return { companies: list?.companies ?? found.companies, fromSaved: false };
  },
});

async function askClaude(industry: string, city: string, known: string[]): Promise<{ companies: Company[]; closed: string[] } | null> {
  const client = new Anthropic();
  const already = known.length ? `\n\nAlready on our list:\n${known.join("\n")}` : "";
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Industry: ${industry}\nCity: ${city}, India${already}` },
  ];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.parse({
        model: "claude-opus-5-5",
        max_tokens: 4000,
        output_config: { effort: "medium", format: zodOutputFormat(CompanyList) },
        system: SYSTEM_PROMPT,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: MAX_SEARCHES,
            user_location: { type: "approximate", city, country: "IN", timezone: "Asia/Kolkata" },
          },
        ],
        messages,
      });
      // A long web search can pause partway; send its work back so Claude carries on.
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      const out = response.parsed_output;
      if (!out) return null;
      const seen = new Set<string>();
      const companies = out.companies
        .map((c) => ({ name: c.name.trim(), website: cleanDomain(c.website) }))
        .filter((c) => c.name && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()))
        .slice(0, MAX_COMPANIES);
      return { companies, closed: out.closed };
    }
    console.warn(`[companies] gave up after ${MAX_TURNS} turns for ${industry} in ${city}`);
    return null;
  } catch (e) {
    console.warn(`[companies] Claude call failed for ${industry} in ${city}: ${String(e)}`);
    return null;
  }
}

// "https://www.Razorpay.com/careers" → "razorpay.com"
function cleanDomain(website: string | null): string | null {
  if (!website) return null;
  const host = website.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}
