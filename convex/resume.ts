"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { v } from "convex/values";
import mammoth from "mammoth";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { rateLimiter } from "./limits";

// Milestone 2: a WhatsApp user sends their resume (PDF, Word .docx, .txt, or pasted text).
// We check it, read it, confirm with Claude that it's a resume, and save it to their profile.

const GRAPH_URL = "https://graph.facebook.com/v23.0";
const MAX_BYTES = 1024 * 1024; // AGENTS.md: attachments up to 1 MB
const MIN_PASTED_CHARS = 300; // shorter text messages are chat, not a pasted resume
const MAX_RESUME_CHARS = 30000;

type Kind = "pdf" | "docx" | "txt";
const KINDS: Record<string, Kind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
};
const EXTENSIONS: Record<string, Kind> = { pdf: "pdf", docx: "docx", txt: "txt" };

const REPLY = {
  welcome:
    "Hi! Send me your resume and I'll find jobs that fit you. A PDF or Word file works, or paste it here as text.",
  wrongFormat:
    "Sorry, I can't read that kind of file. Please send your resume as a PDF or Word (.docx) file, or paste it here as text.",
  tooBig: "That file is over 1 MB. Please send a smaller PDF or Word file, or paste your resume here as text.",
  angleBrackets: "Please send your resume without the < and > characters, or as a PDF or Word file.",
  photo: "I can't read photos yet. Please send your resume as a PDF or Word file, or paste it here as text.",
  notResume:
    "That doesn't look like a resume. Please send your resume as a PDF or Word file, or paste it here as text.",
  unreadable:
    "I couldn't read that file. Please try another PDF or Word file, or paste your resume here as text.",
  busy: "Busy right now. Try again in a few minutes.",
  saved: (summary: string) =>
    `Got your resume: ${summary}. I'll use it to find jobs that fit you.`,
};

const ResumeCheck = z.object({
  isResume: z.boolean(),
  summary: z.string().nullable(),
  resumeText: z.string().nullable(),
});

const SYSTEM_PROMPT = `You read a document a job seeker sent to a job-finding app.

isResume: true only if it is a resume or CV of a person.
summary: if it is a resume, one factual line under 15 words: current role, years of experience, industry. Example: "Senior Product Manager, 11 years, B2B SaaS". No opinions or compliments about the person. Otherwise null.
resumeText: if the document is a PDF and it is a resume, the full resume as plain text, keeping all content and dropping layout. Otherwise null.`;

const reply = (ctx: ActionCtx, to: string, text: string) =>
  ctx.scheduler.runAfter(0, internal.whatsapp.sendReply, { to, text });

// Called for every new incoming WhatsApp message.
export const handleIncoming = internalAction({
  args: {
    phone: v.string(),
    type: v.string(),
    text: v.optional(v.string()),
    mediaId: v.optional(v.string()),
    fileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { phone, type, text, mediaId, fileName, mimeType }) => {
    if (type === "text") {
      const body = text ?? "";
      if (body.trim().length < MIN_PASTED_CHARS) return void (await reply(ctx, phone, REPLY.welcome));
      if (/[<>]/.test(body)) return void (await reply(ctx, phone, REPLY.angleBrackets));
      return void (await readAndSave(ctx, phone, { text: body }));
    }
    if (type === "image") return void (await reply(ctx, phone, REPLY.photo));
    if (type !== "document" || !mediaId) return void (await reply(ctx, phone, REPLY.wrongFormat));

    const kind = kindOf(mimeType, fileName);
    if (!kind) return void (await reply(ctx, phone, REPLY.wrongFormat));

    const download = await downloadFromWhatsApp(mediaId);
    if (download === "tooBig") return void (await reply(ctx, phone, REPLY.tooBig));
    if (!download) return void (await reply(ctx, phone, REPLY.unreadable));
    const fileId = await ctx.storage.store(new Blob([download], { type: mimeType }));
    await readAndSave(ctx, phone, { fileId, kind, fileName });
    return null;
  },
});

// Reads a resume file already in Convex storage. handleIncoming uses the same steps after
// downloading from WhatsApp; the test script calls this directly with made-up resumes.
export const ingestFile = internalAction({
  args: {
    phone: v.string(),
    fileId: v.id("_storage"),
    fileName: v.string(),
    mimeType: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { phone, fileId, fileName, mimeType }) => {
    const kind = kindOf(mimeType, fileName);
    if (!kind) {
      await ctx.storage.delete(fileId);
      return void (await reply(ctx, phone, REPLY.wrongFormat));
    }
    await readAndSave(ctx, phone, { fileId, kind, fileName });
    return null;
  },
});

async function readAndSave(
  ctx: ActionCtx,
  phone: string,
  input: { text: string } | { fileId: Id<"_storage">; kind: Kind; fileName?: string },
): Promise<void> {
  // 1. Get the content: pasted text, or the stored file (size-checked).
  let kind: Kind | "pasted" = "pasted";
  let text: string | null = null;
  let pdf: Buffer | null = null;
  let fileId: Id<"_storage"> | undefined;
  let fileName: string | undefined;
  if ("text" in input) {
    text = input.text;
  } else {
    ({ fileId, kind, fileName } = input);
    const blob = await ctx.storage.get(fileId);
    if (!blob || blob.size > MAX_BYTES) {
      await ctx.storage.delete(fileId);
      return void (await reply(ctx, phone, blob ? REPLY.tooBig : REPLY.unreadable));
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    try {
      if (kind === "pdf") pdf = bytes;
      else if (kind === "docx") text = (await mammoth.extractRawText({ buffer: bytes })).value;
      else text = bytes.toString("utf8");
    } catch (e) {
      console.warn(`[resume] couldn't read ${kind} from ${phone}: ${String(e)}`);
    }
  }
  if (!pdf && !text?.trim()) {
    if (fileId) await ctx.storage.delete(fileId);
    return void (await reply(ctx, phone, REPLY.unreadable));
  }
  text = text?.slice(0, MAX_RESUME_CHARS) ?? null;

  // 2. Ask Claude: is it a resume, and a one-line summary (plus the text, for PDFs).
  const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
  if (!ok) {
    if (fileId) await ctx.storage.delete(fileId);
    return void (await reply(ctx, phone, REPLY.busy));
  }
  let check: z.infer<typeof ResumeCheck> | null = null;
  try {
    const response = await new Anthropic().messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "medium", format: zodOutputFormat(ResumeCheck) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: pdf
            ? [
                {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
                },
                { type: "text", text: "This is a PDF." },
              ]
            : `<document>\n${text}\n</document>`,
        },
      ],
    });
    if (response.stop_reason !== "refusal") check = response.parsed_output ?? null;
    if (!check) console.warn(`[resume] no answer for ${phone} (stop: ${response.stop_reason})`);
  } catch (e) {
    console.warn(`[resume] Claude call failed for ${phone}: ${String(e)}`);
  }
  if (!check) {
    if (fileId) await ctx.storage.delete(fileId);
    return void (await reply(ctx, phone, REPLY.busy));
  }

  // 3. Save it, or explain why not.
  const resumeText = pdf ? check.resumeText : text;
  if (!check.isResume || !check.summary || !resumeText?.trim()) {
    if (fileId) await ctx.storage.delete(fileId);
    return void (await reply(ctx, phone, check.isResume ? REPLY.unreadable : REPLY.notResume));
  }
  await ctx.runMutation(internal.profile.saveUserResume, {
    phone,
    resumeText: resumeText.slice(0, MAX_RESUME_CHARS),
    resumeSummary: check.summary,
    resumeFileId: fileId,
    resumeFileName: fileName,
  });
  await reply(ctx, phone, REPLY.saved(check.summary.replace(/\.$/, "")));
}

function kindOf(mimeType?: string, fileName?: string): Kind | null {
  if (mimeType && KINDS[mimeType]) return KINDS[mimeType];
  const ext = fileName?.split(".").pop()?.toLowerCase();
  return (ext && EXTENSIONS[ext]) || null;
}

// WhatsApp sends a media id: swap it for a short-lived link, then download with the access token.
// Returns null if it can't (no token yet, or Meta refused), "tooBig" if over 1 MB.
async function downloadFromWhatsApp(mediaId: string): Promise<ArrayBuffer | "tooBig" | null> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    console.log(`[resume] no WHATSAPP_TOKEN yet; can't download media ${mediaId}`);
    return null;
  }
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const meta = await fetch(`${GRAPH_URL}/${mediaId}`, { headers });
    if (!meta.ok) throw new Error(`media lookup returned ${meta.status}`);
    const info = (await meta.json()) as { url?: string; file_size?: number };
    if (!info.url) throw new Error("media lookup had no url");
    if ((info.file_size ?? 0) > MAX_BYTES) return "tooBig";
    const file = await fetch(info.url, { headers });
    if (!file.ok) throw new Error(`media download returned ${file.status}`);
    const bytes = await file.arrayBuffer();
    return bytes.byteLength > MAX_BYTES ? "tooBig" : bytes;
  } catch (e) {
    console.warn(`[resume] couldn't download media ${mediaId}: ${String(e)}`);
    return null;
  }
}
