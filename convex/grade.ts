"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { scoreOfFour } from "./evalScore";
import { rateLimiter } from "./limits";

// Observability, Document Read row: a separate Claude check (not the call that read the resume)
// compares what we pulled out with the original document the user sent. Runs after the user has
// had their reply, so it never slows the chat. One Claude call per resume.

const Item = z.object({ ok: z.boolean(), note: z.string() });
const Grade = z.object({ role: Item, industry: Item, location: Item, document: Item });

const SYSTEM_PROMPT = `You check another system's work. It read a resume a job seeker sent and pulled out details. You get the original document and what it pulled out. For each item, say whether it is correct according to the document, with a short note (under 20 words) saying why.

role: is the job title right for the person's most recent role?
industry: is the industry right for their most recent job?
location: is the city right, if the document says where they live? If the document doesn't say and the system left it empty, that's correct.
document: does the extracted text contain all of the document's content (every job, education, skills), without made-up or missing sections? Small layout differences don't matter.

Judge only against the document. Don't comment on the person.`;

export const gradeDocument = internalAction({
  args: {
    phone: v.string(),
    kind: v.string(), // pdf, docx, doc, txt, image, photos, text
    fileName: v.optional(v.string()),
    fileIds: v.array(v.id("_storage")), // PDFs and photos: the original, to compare against
    sourceText: v.optional(v.string()), // Word, .txt and pasted text: the original text
    extracted: v.object({
      summary: v.string(),
      role: v.union(v.string(), v.null()),
      industry: v.union(v.string(), v.null()),
      location: v.union(v.string(), v.null()),
      resumeText: v.string(),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const input = { kind: args.kind, fileName: args.fileName ?? null, document: args.sourceText ?? `(original ${args.kind} file, ${args.fileIds.length} page(s))` };
    const output = args.extracted;
    const pending = async (note: string) =>
      ctx.runMutation(internal.evals.log, {
        phone: args.phone, lever: "document_read", input, output, score: "pending",
        checks: [{ item: "grading", ok: false, note }], judgedBy: "claude",
      });

    // The original document: the file itself for PDFs and photos, else the original text.
    const original: Anthropic.ContentBlockParam[] = [];
    for (const id of args.fileIds) {
      const blob = await ctx.storage.get(id);
      if (!blob) continue;
      const data = Buffer.from(await blob.arrayBuffer()).toString("base64");
      if (args.kind === "pdf") original.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      else original.push({ type: "image", source: { type: "base64", media_type: blob.type === "image/png" ? "image/png" : "image/jpeg", data } });
    }
    if (!original.length && !args.sourceText) {
      await pending("original document no longer available");
      return null;
    }

    const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
    if (!ok) {
      await pending("not graded: hourly Claude limit reached");
      return null;
    }
    try {
      const response = await new Anthropic().messages.parse({
        model: "claude-opus-5-5",
        max_tokens: 4000,
        output_config: { effort: "medium", format: zodOutputFormat(Grade) },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...(original.length ? original : [{ type: "text" as const, text: `<original>\n${args.sourceText}\n</original>` }]),
              {
                type: "text",
                text: `What the system pulled out:\nrole: ${output.role ?? "(empty)"}\nindustry: ${output.industry ?? "(empty)"}\nlocation: ${output.location ?? "(empty)"}\n<extracted_text>\n${output.resumeText}\n</extracted_text>`,
              },
            ],
          },
        ],
      });
      const grade = response.parsed_output;
      if (!grade) {
        await pending(`no grade (stop: ${response.stop_reason})`);
        return null;
      }
      const checks = (["role", "industry", "location", "document"] as const).map((item) => ({ item, ok: grade[item].ok, note: grade[item].note }));
      await ctx.runMutation(internal.evals.log, {
        phone: args.phone, lever: "document_read", input, output, score: scoreOfFour(checks), checks, judgedBy: "claude",
      });
    } catch (e) {
      console.warn(`[grade] document grading failed for ${args.phone}: ${String(e)}`);
      await pending("not graded: Claude call failed");
    }
    return null;
  },
});
