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

export default defineSchema({
  // One row: the resume text the job finder compares against, and the user's preferences.
  profile: defineTable({
    resumeText: v.string(),
    preferences: v.optional(preferencesValidator),
    updatedAt: v.number(),
  }),

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
