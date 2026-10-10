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
  likes: v.optional(v.array(v.string())), // jobs they said they want more of, e.g. "Senior PM at Okta"
  dislikes: v.optional(v.array(v.string())), // jobs they said they don't want more of
});

// Which question a WhatsApp user is answering after sending their resume.
export const stageValidator = v.union(
  v.literal("industry_choice"), // same industry or different?
  v.literal("industry_input"), // which industry?
  v.literal("location_choice"), // where you are now, or somewhere else?
  v.literal("location_input"), // which city?
  v.literal("ready"), // all answered
  v.literal("job_feedback"), // "want more jobs like this one?" after explaining a job
);

// What happened to a job in a search.
export const outcomeValidator = v.union(
  v.literal("shown"),
  v.literal("too_old"),
  v.literal("wrong_title"),
  v.literal("duplicate"),
  v.literal("unreadable"), // couldn't load the job description
  v.literal("unchecked"), // Claude couldn't check it (hourly limit or error)
  v.literal("not_a_fit"),
  v.literal("broke_preference"),
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
    currentRole: v.optional(v.string()), // job title to search for, from the resume
    currentIndustry: v.optional(v.string()),
    currentLocation: v.optional(v.string()),
    stage: v.optional(stageValidator),
    searchStartedAt: v.optional(v.number()), // set while a job search runs, so we don't start two
    pendingJob: v.optional(v.string()), // the job a "want more like this?" answer is about

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

  // Every job search run for a WhatsApp user.
  searches: defineTable({
    phone: v.string(),
    search: v.string(), // e.g. "Senior Product Manager B2B SaaS" in Pune, last 7 days
    summary: v.string(), // counts of what was dropped and why
  }).index("by_phone", ["phone"]),

  // Every job a search looked at, shown or not, with the reason. Lets us explain any job later.
  jobsSeen: defineTable({
    phone: v.string(),
    searchId: v.id("searches"),
    jobId: v.string(), // LinkedIn's job id
    title: v.string(),
    company: v.string(),
    location: v.string(),
    postedOn: v.string(),
    url: v.string(),
    outcome: outcomeValidator,
    fit: v.optional(v.union(v.literal("strong"), v.literal("partial"), v.literal("not_a_fit"))),
    reason: v.optional(v.string()),
    caveat: v.optional(v.string()),
    brokenPreference: v.optional(v.string()),
  }).index("by_phone_and_jobId", ["phone", "jobId"]),
});
