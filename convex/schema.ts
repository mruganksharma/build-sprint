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
  portals: v.optional(v.array(v.string())), // other job sites they asked us to search, e.g. "Naukri"
});

// Which question a WhatsApp user is answering after sending their resume.
export const stageValidator = v.union(
  v.literal("industry_choice"), // same industry or different?
  v.literal("industry_input"), // which industry?
  v.literal("location_choice"), // where you are now, or somewhere else?
  v.literal("location_input"), // which city?
  v.literal("days_choice"), // jobs from the last 24 hours, 7 days or 30 days?
  v.literal("ready"), // all answered
  v.literal("job_feedback"), // "want more jobs like this one?" after explaining a job
  v.literal("portal_input"), // "which other job site should I search?" after nothing fit
  v.literal("widen_offer"), // "want me to look at the last 7 days too?" after few jobs fit
  v.literal("alerts_choice"), // "want new jobs every day?" after their first reply to a job list
  v.literal("alerts_time"), // "what time should I send them?"
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
  v.literal("already_sent"), // sent to them in a recent search; not sent again
  v.literal("not_checked"), // past the 10 jobs we check per search
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
    resumeExtraFileIds: v.optional(v.array(v.id("_storage"))), // pages 2+ when sent as several photos
    contactEmail: v.optional(v.string()), // from the resume
    linkedinUrl: v.optional(v.string()), // from the resume
    preferences: v.optional(preferencesValidator),
    // WhatsApp users: what the resume says today, and where they are in the questions after it.
    currentRole: v.optional(v.string()), // job title to search for, from the resume
    currentIndustry: v.optional(v.string()),
    currentLocation: v.optional(v.string()),
    stage: v.optional(stageValidator),
    searchStartedAt: v.optional(v.number()), // set while a job search runs, so we don't start two
    searchQueued: v.optional(v.boolean()), // they changed what they want mid-search: search again after
    // Daily job alerts: the hour (0-23, India time) to search and send new jobs. Not set = off.
    alertHour: v.optional(v.number()),
    alertJobId: v.optional(v.id("_scheduled_functions")), // the next alert's booked run, to cancel on change
    alertsAsked: v.optional(v.boolean()), // asked once, after their first reply to a job list
    listSentAt: v.optional(v.number()), // when we last sent them a list of jobs
    pendingJob: v.optional(v.string()), // the job a "want more like this?" answer is about

    updatedAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_alertHour", ["alertHour"]),

  // Companies by industry and location, one row each, found by Claude (its own knowledge plus web
  // search) and shared by every user. The list only grows; closed companies are deleted.
  companies: defineTable({
    key: v.string(), // "fintech|mumbai": industry and location, lowercase
    industry: v.string(),
    city: v.string(),
    name: v.string(),
    website: v.union(v.string(), v.null()), // their main site, e.g. "razorpay.com"
    addedAt: v.number(),
  }).index("by_key", ["key"]),

  // Per industry and location: when the company list was last refreshed, and a lock so two
  // background refreshes never run at once.
  companyPrep: defineTable({ key: v.string(), startedAt: v.number(), refreshedAt: v.optional(v.number()) }).index("by_key", ["key"]),

  // Where a company lists its open jobs, found from its website (see careers.ts). Shared by every
  // company list it appears in; checked again after a week.
  companyBoards: defineTable({
    key: v.string(), // the company's website, or its name if it has none
    name: v.string(),
    system: v.union(
      v.literal("greenhouse"),
      v.literal("lever"),
      v.literal("ashby"),
      v.literal("workable"),
      v.literal("smartrecruiters"),
      v.literal("keka"),
      v.literal("other"), // a hiring system we can't read for free yet (named in otherSystem)
      v.literal("none"), // no job list found
    ),
    slug: v.optional(v.string()), // the company's name on that hiring system
    otherSystem: v.optional(v.string()), // e.g. "Darwinbox", "Workday"
    careersUrl: v.optional(v.string()),
    jobsTotal: v.optional(v.number()),
    jobsInIndia: v.optional(v.number()),
    checkedAt: v.number(),
  }).index("by_key", ["key"]),

  // Observability: every output of the agent, scored against the rubric (see evals.ts). One row per
  // resume read (document_read), and per search (preference, jobs_found, job_fit).
  evals: defineTable({
    phone: v.string(),
    lever: v.union(v.literal("document_read"), v.literal("preference"), v.literal("jobs_found"), v.literal("job_fit")),
    searchId: v.optional(v.id("searches")),
    input: v.string(), // JSON: what went in
    output: v.string(), // JSON: what came out
    score: v.union(v.literal("best"), v.literal("between"), v.literal("worst"), v.literal("pending")),
    checks: v.array(v.object({ item: v.string(), ok: v.boolean(), note: v.string() })),
    judgedBy: v.union(v.literal("rules"), v.literal("claude"), v.literal("user_replies")),
    updatedAt: v.number(),
  })
    .index("by_searchId_and_lever", ["searchId", "lever"])
    .index("by_phone", ["phone"])
    .index("by_updatedAt", ["updatedAt"]),

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
      // outgoing only; "queued" = waiting for the Hermes relay to pick it up and send it
      v.union(v.literal("sent"), v.literal("failed"), v.literal("logged_only"), v.literal("queued")),
    ),
    // How the message travelled. Unset = Meta's WhatsApp Cloud API; "hermes" = the Hermes relay
    // on the test number. Replies go back the way the user's latest message came in.
    channel: v.optional(v.literal("hermes")),
  })
    .index("by_waMessageId", ["waMessageId"])
    .index("by_phone", ["phone"])
    .index("by_channel_and_status", ["channel", "status"]),

  // Every job search run for a WhatsApp user.
  searches: defineTable({
    phone: v.string(),
    search: v.string(), // e.g. "Senior Product Manager B2B SaaS" in Pune, last 7 days
    summary: v.string(), // counts of what was dropped and why
    shown: v.optional(v.array(v.string())), // job ids in the order sent, so "3 no" finds job 3
    matchKey: v.optional(v.string()), // same resume + same hard preferences → earlier verdicts still hold
    closeShown: v.optional(v.array(v.string())), // close-but-not-quite jobs listed, so each is listed once
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
    matchKey: v.optional(v.string()),
  }).index("by_phone_and_jobId", ["phone", "jobId"]),

  // Resume photos waiting a few seconds in case more pages follow; read together as one resume.
  pendingPhotos: defineTable({
    phone: v.string(),
    fileId: v.id("_storage"),
    mimeType: v.string(),
  }).index("by_phone", ["phone"]),
});
