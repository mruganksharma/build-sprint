import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Companies by industry and location, one row each (see companies.ts, which finds them). A list
// only grows: each weekly refresh adds the companies Claude finds that we didn't have, and deletes
// only the ones Claude says have shut down or left the city.

const MAX_PER_LIST = 1000;
const companyValidator = v.object({ name: v.string(), website: v.union(v.string(), v.null()) });
const sameCompany = (c: { name: string; website: string | null }) => c.website ?? c.name.toLowerCase();

// The companies for one industry and location, and when that list was last refreshed.
export const get = internalQuery({
  args: { key: v.string() },
  returns: v.union(v.object({ companies: v.array(companyValidator), foundAt: v.number() }), v.null()),
  handler: async (ctx, { key }) => {
    const rows = await ctx.db
      .query("companies")
      .withIndex("by_key", (q) => q.eq("key", key))
      .take(MAX_PER_LIST);
    if (!rows.length) return null;
    const prep = await ctx.db
      .query("companyPrep")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    return {
      companies: rows.map((r) => ({ name: r.name, website: r.website })),
      foundAt: prep?.refreshedAt ?? Math.max(...rows.map((r) => r.addedAt)),
    };
  },
});

// Adds the companies found this time that aren't on the list yet, and deletes the closed ones.
// Returns how many companies the list now has.
export const save = internalMutation({
  args: {
    key: v.string(),
    industry: v.string(),
    city: v.string(),
    companies: v.array(companyValidator), // found this time
    closed: v.optional(v.array(v.string())), // names Claude says shut down or left the city
  },
  returns: v.number(),
  handler: async (ctx, { key, industry, city, companies, closed = [] }) => {
    const rows = await ctx.db
      .query("companies")
      .withIndex("by_key", (q) => q.eq("key", key))
      .take(MAX_PER_LIST);
    const gone = new Set(closed.map((name) => name.trim().toLowerCase()));
    const have = new Set<string>();
    let count = 0;
    for (const row of rows) {
      if (gone.has(row.name.toLowerCase())) await ctx.db.delete(row._id);
      else {
        have.add(sameCompany(row));
        count++;
      }
    }
    for (const c of companies) {
      if (gone.has(c.name.toLowerCase()) || have.has(sameCompany(c)) || count >= MAX_PER_LIST) continue;
      await ctx.db.insert("companies", { key, industry, city, name: c.name, website: c.website, addedAt: Date.now() });
      have.add(sameCompany(c));
      count++;
    }
    const prep = await ctx.db
      .query("companyPrep")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (prep) await ctx.db.patch(prep._id, { refreshedAt: Date.now() });
    else await ctx.db.insert("companyPrep", { key, startedAt: 0, refreshedAt: Date.now() });
    return count;
  },
});

// Only one background refresh per industry and location at a time. True = go ahead.
const PREPARE_LOCK_MS = 30 * 60 * 1000;
export const claimPrepare = internalMutation({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("companyPrep")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (row && Date.now() - row.startedAt < PREPARE_LOCK_MS) return false;
    if (row) await ctx.db.patch(row._id, { startedAt: Date.now() });
    else await ctx.db.insert("companyPrep", { key, startedAt: Date.now() });
    return true;
  },
});

// For tests: remove a made-up list and its refresh record. Only keys starting with "test-".
export const removeForTest = internalMutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    if (!key.startsWith("test-")) return null;
    for (const row of await ctx.db
      .query("companies")
      .withIndex("by_key", (q) => q.eq("key", key))
      .take(MAX_PER_LIST)) {
      await ctx.db.delete(row._id);
    }
    const prep = await ctx.db
      .query("companyPrep")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (prep) await ctx.db.delete(prep._id);
    return null;
  },
});
