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

// Milestones 2 and 3: a WhatsApp user sends their resume as a PDF, Word .docx, .txt, pasted text,
// a photo, or a link (website or Google Drive). We check it, read it, confirm with Claude that
// it's a resume, and save it to their profile.

const GRAPH_URL = "https://graph.facebook.com/v23.0";
const MAX_BYTES = 1024 * 1024; // AGENTS.md: attachments up to 1 MB
const MIN_PASTED_CHARS = 300; // shorter text messages are chat or a link, not a pasted resume
const MIN_PAGE_CHARS = 200; // a web page with less text than this has nothing to read
const MAX_RESUME_CHARS = 30000;
const FETCH_TIMEOUT_MS = 10000;

type Kind = "pdf" | "docx" | "txt" | "image";
const KINDS: Record<string, Kind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "image/jpeg": "image",
  "image/png": "image",
};
const EXTENSIONS: Record<string, Kind> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  jpg: "image",
  jpeg: "image",
  png: "image",
};
const IMAGE_TYPES: Record<string, "image/jpeg" | "image/png"> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const REPLY = {
  welcome:
    "Hi! Send me your resume and I'll find jobs that fit you. A PDF or Word file works, a photo of it, a link, or paste it here as text.",
  wrongFormat:
    "Sorry, I can't read that kind of file. Please send your resume as a PDF or Word (.docx) file, or paste it here as text.",
  tooBig: "That file is over 1 MB. Please send a smaller PDF or Word file, or paste your resume here as text.",
  angleBrackets: "Please send your resume without the < and > characters, or as a PDF or Word file.",
  photoUnclear:
    "I couldn't read that photo clearly. Please send a sharper photo in good light, or your resume as a PDF or Word file.",
  notResume:
    "That doesn't look like a resume. Please send your resume as a PDF or Word file, or paste it here as text.",
  unreadable:
    "I couldn't read that file. Please try another PDF or Word file, or paste your resume here as text.",
  linkedin:
    "I can't open LinkedIn profiles. On a computer, open your LinkedIn profile, click More, then Save to PDF, and send me that PDF.",
  drivePrivate:
    "I couldn't open that Google Drive file. Please set its sharing to 'Anyone with the link' and send the link again, or send me the file itself.",
  linkBroken: "I couldn't open that link. Please check it, or send your resume as a PDF or Word file.",
  linkNoText:
    "I couldn't find any text on that page. Please send your resume as a PDF or Word file, or paste it here as text.",
  busy: "Busy right now. Try again in a few minutes.",
  saved: (summary: string, question: string) => `Got your resume: ${summary}.\n\n${question}`,
};

const ResumeCheck = z.object({
  tooBlurry: z.boolean(),
  isResume: z.boolean(),
  summary: z.string().nullable(),
  role: z.string().nullable(),
  industry: z.string().nullable(),
  location: z.string().nullable(),
  resumeText: z.string().nullable(),
});

const SYSTEM_PROMPT = `You read a document a job seeker sent to a job-finding app.

tooBlurry: true if it is a photo or PDF where you can't make out most of the words (blurry, tiny, dark, cut off), so you can't tell what it is. Otherwise false.
isResume: true only if it is a resume or CV of a person.
summary: if it is a resume, one factual line under 15 words: current role, years of experience, industry. Example: "Senior Product Manager, 11 years, B2B SaaS". No opinions or compliments about the person. Otherwise null.
role: if it is a resume, the job title to search job boards for: their most recent title in plain words, e.g. "Senior Product Manager", "Data Scientist", "Sales Manager". Null if unclear or not a resume.
industry: if it is a resume, the industry of their most recent job in 1 to 3 words, e.g. "B2B SaaS", "Fintech", "Healthcare". Null if unclear or not a resume.
location: if it is a resume and it says where they live, just the city, e.g. "Bengaluru". Otherwise null.
resumeText: if the document is a PDF or a photo and it is a resume, the full resume as plain text, keeping all content and dropping layout. If it is a resume but you can't read most of the text (blurry, cut off, too small), null. For anything else, null.`;

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
      const body = (text ?? "").trim();
      const link = body.length < MIN_PASTED_CHARS ? findLink(body) : null;
      if (link) return void (await readLink(ctx, phone, link));
      if (body.length < MIN_PASTED_CHARS) {
        // A short answer to one of the questions after the resume, or a hello from someone new.
        const answer = await ctx.runMutation(internal.chat.handleAnswer, { phone, text: body });
        return void (await reply(ctx, phone, answer ?? REPLY.welcome));
      }
      if (/[<>]/.test(body)) return void (await reply(ctx, phone, REPLY.angleBrackets));
      return void (await readAndSave(ctx, phone, { text: body }));
    }
    if ((type !== "document" && type !== "image") || !mediaId) {
      return void (await reply(ctx, phone, REPLY.wrongFormat));
    }

    const kind = kindOf(mimeType, fileName);
    if (!kind) return void (await reply(ctx, phone, REPLY.wrongFormat));

    const download = await downloadFromWhatsApp(mediaId);
    if (download === "tooBig") return void (await reply(ctx, phone, REPLY.tooBig));
    if (!download) return void (await reply(ctx, phone, REPLY.unreadable));
    const fileId = await ctx.storage.store(new Blob([download], { type: mimeType }));
    await readAndSave(ctx, phone, { fileId, kind, fileName, mimeType });
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
    await readAndSave(ctx, phone, { fileId, kind, fileName, mimeType });
    return null;
  },
});

type FileInput = { fileId: Id<"_storage">; kind: Kind; fileName?: string; mimeType?: string };

async function readAndSave(ctx: ActionCtx, phone: string, input: { text: string } | FileInput): Promise<void> {
  // 1. Get the content: text, or the stored file (size-checked).
  let text: string | null = null;
  let visual: { kind: "pdf" | "image"; data: string; mediaType: string } | null = null;
  let fileId: Id<"_storage"> | undefined;
  let fileName: string | undefined;
  let kind: Kind | "text" = "text";
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
      if (kind === "pdf") visual = { kind, data: bytes.toString("base64"), mediaType: "application/pdf" };
      else if (kind === "image") visual = { kind, data: bytes.toString("base64"), mediaType: imageType(input) };
      else if (kind === "docx") text = (await mammoth.extractRawText({ buffer: bytes })).value;
      else text = bytes.toString("utf8");
    } catch (e) {
      console.warn(`[resume] couldn't read ${kind} from ${phone}: ${String(e)}`);
    }
  }
  const unreadable = kind === "image" ? REPLY.photoUnclear : REPLY.unreadable;
  const discard = async () => {
    if (fileId) await ctx.storage.delete(fileId);
  };
  if (!visual && !text?.trim()) {
    await discard();
    return void (await reply(ctx, phone, unreadable));
  }
  text = text?.slice(0, MAX_RESUME_CHARS) ?? null;

  // 2. Ask Claude: is it a resume, and a one-line summary (plus the text, for PDFs and photos).
  const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
  if (!ok) {
    await discard();
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
          content: visual
            ? [
                visual.kind === "pdf"
                  ? {
                      type: "document" as const,
                      source: { type: "base64" as const, media_type: "application/pdf" as const, data: visual.data },
                    }
                  : {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: visual.mediaType as "image/jpeg" | "image/png",
                        data: visual.data,
                      },
                    },
                { type: "text" as const, text: visual.kind === "pdf" ? "This is a PDF." : "This is a photo." },
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
    await discard();
    return void (await reply(ctx, phone, REPLY.busy));
  }

  // 3. Save it, or explain why not.
  if (check.tooBlurry) {
    await discard();
    return void (await reply(ctx, phone, unreadable));
  }
  const resumeText = visual ? check.resumeText : text;
  if (!check.isResume || !check.summary || !resumeText?.trim()) {
    await discard();
    return void (await reply(ctx, phone, check.isResume ? unreadable : REPLY.notResume));
  }
  const firstQuestion = await ctx.runMutation(internal.profile.saveUserResume, {
    phone,
    resumeText: resumeText.slice(0, MAX_RESUME_CHARS),
    resumeSummary: check.summary,
    resumeFileId: fileId,
    resumeFileName: fileName,
    currentRole: check.role ?? undefined,
    currentIndustry: check.industry ?? undefined,
    currentLocation: check.location ?? undefined,
  });
  await reply(ctx, phone, REPLY.saved(check.summary.replace(/\.$/, ""), firstQuestion));
}

// ---------- links ----------

function findLink(text: string): URL | null {
  const match = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0].startsWith("www.") ? `https://${match[0]}` : match[0]);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// Only fetch ordinary public web addresses: no bare IP addresses, no local or internal names.
function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":")) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h);
}

// Google Drive and Docs share links point at a viewer page; this finds the direct download address.
function driveDownloadUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "drive.google.com") {
    const id = url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] ?? url.searchParams.get("id");
    return id ? `https://drive.google.com/uc?export=download&id=${id}` : null;
  }
  if (host === "docs.google.com") {
    const id = url.pathname.match(/\/document\/d\/([\w-]+)/)?.[1];
    return id ? `https://docs.google.com/document/d/${id}/export?format=txt` : null;
  }
  return null;
}

async function readLink(ctx: ActionCtx, phone: string, url: URL): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    // A job link ("why didn't you show me this?") gets explained; a profile link can't be read.
    const jobId = url.searchParams.get("currentJobId") ?? url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1];
    if (jobId) return void (await ctx.scheduler.runAfter(0, internal.jobs.explainJob, { phone, jobId }));
    return void (await reply(ctx, phone, REPLY.linkedin));
  }
  if (!isPublicHost(host)) return void (await reply(ctx, phone, REPLY.linkBroken));

  const isDrive = host === "drive.google.com" || host === "docs.google.com";
  const target = isDrive ? driveDownloadUrl(url) : url.toString();
  if (!target) return void (await reply(ctx, phone, REPLY.drivePrivate));
  const failed = isDrive ? REPLY.drivePrivate : REPLY.linkBroken;

  let res: Response;
  try {
    res = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    console.warn(`[resume] couldn't fetch ${target}: ${String(e)}`);
    return void (await reply(ctx, phone, failed));
  }
  if (!res.ok || !isPublicHost(new URL(res.url).hostname)) return void (await reply(ctx, phone, failed));

  const body = await readCapped(res);
  if (body === "tooBig") return void (await reply(ctx, phone, REPLY.tooBig));
  if (!body) return void (await reply(ctx, phone, failed));

  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mimeType === "text/html") {
    // A private Drive file answers with Google's sign-in page instead of the file.
    if (isDrive) return void (await reply(ctx, phone, REPLY.drivePrivate));
    const pageText = htmlToText(body.toString("utf8"));
    if (pageText.length < MIN_PAGE_CHARS) return void (await reply(ctx, phone, REPLY.linkNoText));
    return void (await readAndSave(ctx, phone, { text: pageText }));
  }
  const fileName = url.pathname.split("/").pop() || url.hostname;
  const kind = KINDS[mimeType] ?? kindOf(undefined, fileName);
  if (!kind) return void (await reply(ctx, phone, REPLY.wrongFormat));
  const fileId = await ctx.storage.store(new Blob([new Uint8Array(body)], { type: mimeType }));
  await readAndSave(ctx, phone, { fileId, kind, fileName: url.toString(), mimeType });
}

// Reads a response body, giving up past 1 MB.
async function readCapped(res: Response): Promise<Buffer | "tooBig" | null> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return "tooBig";
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return "tooBig";
      }
      chunks.push(value);
    }
  } catch (e) {
    console.warn(`[resume] link download stopped: ${String(e)}`);
    return null;
  }
  return Buffer.concat(chunks);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "‹")
    .replace(/&gt;/g, "›")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// ---------- files ----------

function kindOf(mimeType?: string, fileName?: string): Kind | null {
  if (mimeType && KINDS[mimeType]) return KINDS[mimeType];
  const ext = fileName?.split(".").pop()?.toLowerCase();
  return (ext && EXTENSIONS[ext]) || null;
}

function imageType({ mimeType, fileName }: FileInput): string {
  if (mimeType === "image/jpeg" || mimeType === "image/png") return mimeType;
  return IMAGE_TYPES[fileName?.split(".").pop()?.toLowerCase() ?? ""] ?? "image/jpeg";
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
