"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { rateLimiter } from "./limits";

// A WhatsApp message the app can't handle on its own ("add fintech too", "no", "what happens
// next?"): Claude reads it with the recent chat, works out what the user wants, and writes the
// reply. The app then saves any change and starts a search if needed (chat.applyUnderstood).

const BUSY = "Busy right now. Try again in a few minutes.";

const Understood = z.object({
  reply: z.string(),
  role: z.string().nullable(),
  industries: z.array(z.string()).nullable(),
  industriesMode: z.enum(["add", "replace"]).nullable(),
  location: z.string().nullable(),
  days: z.number().nullable(),
  avoid: z.array(z.string()).nullable(),
  mustHaves: z.array(z.string()).nullable(),
  jobSites: z.array(z.string()).nullable(),
  rateJob: z.object({ number: z.number(), liked: z.boolean() }).nullable(),
  startOver: z.boolean(),
  search: z.boolean(),
});

const SYSTEM_PROMPT = `You are the chat side of a WhatsApp job-finding app. The user sends their resume; the app asks which industry, city and how recent the jobs should be; then it searches LinkedIn and sends matching jobs in the chat. It can only search LinkedIn today.

You get the user's newest message, the recent chat, and what the app knows about them. Work out what they want and fill in the fields. People say the same thing in many different ways and with typos: go by meaning, not exact words. Use the recent chat to understand short replies like "no", "yes" or "that one".

Fields (null, empty or false when the message doesn't ask for it):
role: a different job title to search for, e.g. "Head of Product".
industries + industriesMode: industries they want jobs in. "add" if they want these as well as what they have ("also", "as well", "widen"); "replace" if they want to switch, or if they're answering which industry they want.
location: the city or area they want to work in, e.g. "Pune", "Remote", "India".
days: how far back to look for jobs, in days (24 hours = 1, a week = 7, a month = 30, at most 30).
avoid: industries or companies they don't want.
mustHaves: other things a job must have, in plain words, e.g. "remote or hybrid", "salary above 40 LPA".
jobSites: other job sites they want searched, e.g. "Naukri".
rateJob: if they say they like or don't like a numbered job from the last list.
startOver: true only if they want to go through the questions again from the start.
search: true if they asked for jobs, or changed what to search for and haven't said to wait.

reply: what to send back, in plain friendly words, at most 3 short sentences.
- Say what you understood and changed, e.g. "Added Fintech to B2B SaaS." Don't say you're searching; the app adds that line itself.
- If they're in the middle of a question and answered it, only say what you understood. Don't ask the next question; the app adds it itself.
- If they're in the middle of a question and didn't answer it, answer what they said, then ask the question again in your own words, with its numbered options if it has any.
- If a search is running and they changed nothing, acknowledge what they said and tell them their jobs are on the way.
- If you can't tell what they want, say so in a few words and give 1 or 2 things they can say, in your own words, not a fixed list.
- If they have no resume yet, answer briefly and ask them to send their resume (PDF, Word, a photo, a link, or pasted as text).
- If they ask for something the app can't do (apply for them, write messages, edit their resume, other job sites), say so in one line.
- Never comment on the user, their background or their choices, and never suggest which option they should pick. Never write to or about anyone else. Never use the < or > characters.`;

export async function understandMessage(ctx: ActionCtx, phone: string, text: string): Promise<string> {
  const context = await ctx.runQuery(internal.chat.understandContext, { phone });
  const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
  if (!ok) return BUSY;
  try {
    const response = await new Anthropic().messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(Understood) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: describe(context, text) }],
    });
    const understood = response.parsed_output;
    if (!understood) return BUSY;
    return await ctx.runMutation(internal.chat.applyUnderstood, {
      phone,
      ...understood,
      reply: understood.reply.replace(/[<>]/g, "").trim() || BUSY,
    });
  } catch (e) {
    console.warn(`[understand] Claude call failed for ${phone}: ${String(e)}`);
    return BUSY;
  }
}

type Context = FunctionReturnType<typeof internal.chat.understandContext>;

function describe(c: Context, text: string): string {
  const lines = [
    c.hasResume ? `Their resume: ${c.summary ?? "saved"}.` : "They have not sent a resume yet.",
    c.currentIndustry || c.currentLocation
      ? `From the resume: industry ${c.currentIndustry ?? "unknown"}, based in ${c.currentLocation ?? "unknown"}.`
      : null,
    c.preferences ? `What they've asked for so far: ${JSON.stringify(c.preferences)}` : null,
    c.pendingQuestion ? `The question they're in the middle of answering:\n${c.pendingQuestion}` : null,
    c.searching ? "A job search is running for them right now; results arrive in a minute or two." : null,
    c.lastJobs.length ? `The last list of jobs sent to them:\n${c.lastJobs.map((j, i) => `${i + 1}. ${j}`).join("\n")}` : null,
    c.chat.length ? `Recent chat, oldest first:\n${c.chat.map((m) => `${m.from}: ${m.text}`).join("\n")}` : null,
    `Their newest message:\n${text}`,
  ];
  return lines.filter(Boolean).join("\n\n");
}
