import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  telemetry_events: defineTable({
    schema_version: v.number(),
    event_timestamp: v.string(),
    skill_version: v.string(),
    os: v.string(),
    arch: v.optional(v.string()),
    duration_s: v.optional(v.number()),
    outcome: v.string(),
    mode: v.optional(v.string()),
    steps_run: v.optional(v.string()),
    self_rating: v.optional(v.number()),
    installation_id: v.optional(v.string()),
  })
    .index("by_event_timestamp", ["event_timestamp"])
    .index("by_skill_version", ["skill_version"])
    .index("by_outcome", ["outcome"])
    .index("by_installation_id", ["installation_id"]),

  installations: defineTable({
    installation_id: v.string(),
    first_seen: v.string(),
    last_seen: v.string(),
    skill_version: v.string(),
    os: v.string(),
  })
    .index("by_installation_id", ["installation_id"]),

  feedback_reports: defineTable({
    submitted_at: v.string(),
    skill_version: v.string(),
    self_rating: v.number(),
    mode: v.string(),
    steps_run: v.string(),
    why_not_10: v.string(),
    what_would_make_10: v.string(),
    os: v.optional(v.string()),
    installation_id: v.optional(v.string()),
  })
    .index("by_submitted_at", ["submitted_at"])
    .index("by_self_rating", ["self_rating"]),
});
