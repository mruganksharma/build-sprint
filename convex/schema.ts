import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// What the user wants, on top of their resume. Every field is optional:
// left out means "no rule". Wanted/avoid/mustHaves are treated as hard rules.
export const preferencesValidator = v.object({
  role: v.optional(v.string()), // job title to search for, e.g. "Senior Product Manager"
  industries: v.optional(v.array(v.string())), // job must be in one of these, e.g. ["B2B SaaS"]
  avoid: v.optional(v.array(v.string())), // industries or companies to skip, e.g. ["banks"]
  mustHaves: v.optional(v.array(v.string())), // anything else in plain words, e.g. ["remote or hybrid"]
  location: v.optional(v.string()),
  days: v.optional(v.number()), // how far back to look
});

// Which question a WhatsApp user is answering after sending their resume.
export const stageValidator = v.union(
  v.literal("industry_choice"), // same industry or different?
  v.literal("industry_input"), // which industry?
  v.literal("location_choice"), // where you are now, or somewhere else?
  v.literal("location_input"), // which city?
  v.literal("ready"), // all answered
);

export default defineSchema({
  // One row per user: the resume text the job finder compares against, and their preferences.
  // WhatsApp users are keyed by phone. The row with no phone is the owner's own, set from the terminal.
  profile: defineTable({
    phone: v.optional(v.string()),
    resumeText: v.string(),
    resumeSummary: v.optional(v.string()), // e.g. "Senior Product Manager, 11 years, B2B SaaS"
    resumeFileId: v.optional(v.id("_storage")), // the original file, if they sent one
    resumeFileName: v.optional(v.string()),
    preferences: v.optional(preferencesValidator),
    // WhatsApp users: what the resume says today, and where they are in the questions after it.
    currentIndustry: v.optional(v.string()),
    currentLocation: v.optional(v.string()),
    stage: v.optional(stageValidator),
    updatedAt: v.number(),
  }).index("by_phone", ["phone"]),

  // Every WhatsApp message, in and out, one row each. Phone is the user's WhatsApp number.
  messages: defineTable({
    phone: v.string(),
    direction: v.union(v.literal("in"), v.literal("out")),
    waMessageId: v.optional(v.string()), // WhatsApp's id; used to ignore Meta's repeat deliveries
    type: v.string(), // text, document, image, ...
    text: v.optional(v.string()),
    mediaId: v.optional(v.string()), // for files and photos; downloaded later
    fileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("sent"), v.literal("failed"), v.literal("logged_only")), // outgoing only
    ),
  })
    .index("by_waMessageId", ["waMessageId"])
    .index("by_phone", ["phone"]),
});
