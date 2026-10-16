"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { internalAction } from "./_generated/server";
import { rateLimiter } from "./limits";

// A second source of jobs, step 3 (trial): for a company whose job list we can't read for free,
// Claude finds its careers page (web search) and reads the open jobs off it (web fetch), the way a
// visitor would. Nothing is saved yet: this is a sample to see if it works and what it costs.
//   npx convex run careersRead:readCompany '{"name": "PhonePe", "website": "phonepe.com", "city": "Mumbai"}'

const MAX_TURNS = 4; // a long search can pause; carry on at most this many times
const MAX_JOBS = 60;

const Jobs = z.object({
  careersUrl: z.string().nullable(),
  jobs: z.array(
    z.object({
      title: z.string(),
      location: z.string(),
      url: z.string().nullable(),
      postedOn: z.string().nullable(),
    }),
  ),
  note: z.string(),
});

const SYSTEM_PROMPT = `You help a job-finding app in India read a company's open jobs from its own careers page.

Find the company's official careers page or job list (it may be on their website or on a hiring system they use, like Darwinbox or SuccessFactors). Use web search to find it and web fetch to read it. Only use the company's own pages or its hiring system, never job boards like LinkedIn, Naukri or Indeed.

Return:
careersUrl: the page you read the jobs from, or null if you couldn't find or read one.
jobs: the open jobs listed there (up to ${MAX_JOBS}), each with title, location as written, url to the job if shown (else null), postedOn as YYYY-MM-DD if shown (else null). Only jobs you actually saw on the page; never make one up.
note: one short sentence on what happened, e.g. "Read 23 jobs from their Darwinbox page." or "The page needs JavaScript; no jobs visible."`;

export const readCompany = internalAction({
  args: { name: v.string(), website: v.union(v.string(), v.null()), city: v.string() },
  returns: v.union(
    v.object({
      careersUrl: v.union(v.string(), v.null()),
      jobs: v.array(v.object({ title: v.string(), location: v.string(), url: v.union(v.string(), v.null()), postedOn: v.union(v.string(), v.null()) })),
      note: v.string(),
      calls: v.number(),
      inputTokens: v.number(),
      outputTokens: v.number(),
      seconds: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { name, website, city }) => {
    const started = Date.now();
    const client = new Anthropic();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: `Company: ${name}\nWebsite: ${website ? `https://${website}` : "(unknown)"}\nWe care most about jobs in ${city}, India, but list all you see.` },
    ];
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
        if (!ok) return null;
        calls++;
        const response = await client.messages.parse({
          model: "claude-opus-5-5",
          max_tokens: 4000,
          output_config: { effort: "low", format: zodOutputFormat(Jobs) },
          system: SYSTEM_PROMPT,
          tools: [
            { type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: { type: "approximate", city, country: "IN", timezone: "Asia/Kolkata" } },
            { type: "web_fetch_20250910", name: "web_fetch", max_uses: 4, max_content_tokens: 20000 },
          ],
          messages,
        });
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        if (response.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: response.content });
          continue;
        }
        const out = response.parsed_output;
        if (!out) return null;
        return { ...out, jobs: out.jobs.slice(0, MAX_JOBS), calls, inputTokens, outputTokens, seconds: Math.round((Date.now() - started) / 1000) };
      }
      return null;
    } catch (e) {
      console.warn(`[careersRead] ${name}: ${String(e)}`);
      return null;
    }
  },
});
