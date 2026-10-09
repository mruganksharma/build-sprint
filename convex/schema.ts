import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row: the resume text the job finder compares against.
  profile: defineTable({
    resumeText: v.string(),
    updatedAt: v.number(),
  }),
});
