import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Resume photos waiting for more pages. See queuePhoto in resume.ts.

// Adds a photo; returns how many are now waiting for this user.
export const add = internalMutation({
  args: { phone: v.string(), fileId: v.id("_storage"), mimeType: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await ctx.db.insert("pendingPhotos", args);
    return (await ctx.db.query("pendingPhotos").withIndex("by_phone", (q) => q.eq("phone", args.phone)).take(50)).length;
  },
});

// If exactly `expected` photos are waiting (no newer ones), hands them over, oldest first.
export const takeIfCount = internalMutation({
  args: { phone: v.string(), expected: v.number() },
  returns: v.union(v.array(v.object({ fileId: v.id("_storage"), mimeType: v.string() })), v.null()),
  handler: async (ctx, { phone, expected }) => {
    const rows = await ctx.db.query("pendingPhotos").withIndex("by_phone", (q) => q.eq("phone", phone)).take(50);
    if (rows.length !== expected) return null;
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.map((row) => ({ fileId: row.fileId, mimeType: row.mimeType }));
  },
});

// Drops all waiting photos (and their files).
export const clear = internalMutation({
  args: { phone: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone }) => {
    const rows = await ctx.db.query("pendingPhotos").withIndex("by_phone", (q) => q.eq("phone", phone)).take(50);
    for (const row of rows) {
      await ctx.storage.delete(row.fileId);
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
