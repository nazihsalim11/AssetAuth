import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Helper to filter documents in memory or dynamically
function applyFilters(q, filter) {
  if (!filter) return q;
  // If simple equality object { field: val }
  let query = q;
  for (const [key, val] of Object.entries(filter)) {
    if (val !== undefined && val !== null) {
      query = query.filter((q) => q.eq(q.field(key), val));
    }
  }
  return query;
}

export const list = query({
  args: {
    table: v.string(),
    filter: v.optional(v.any()),
    orderBy: v.optional(v.string()), // "createdAt" etc.
    orderDir: v.optional(v.string()), // "asc" or "desc"
  },
  handler: async (ctx, args) => {
    let q = ctx.db.query(args.table);
    if (args.filter) {
      // If we have an index for specific table/fields, we could use it, 
      // but dynamic filters are fully supported in JS using filter()
      for (const [key, val] of Object.entries(args.filter)) {
        if (val !== undefined && val !== null) {
          q = q.filter((d) => d.eq(d.field(key), val));
        }
      }
    }
    const results = await q.collect();
    if (args.orderBy) {
      results.sort((a, b) => {
        const valA = a[args.orderBy];
        const valB = b[args.orderBy];
        if (valA === valB) return 0;
        if (valA === undefined || valA === null) return 1;
        if (valB === undefined || valB === null) return -1;
        if (typeof valA === "string") {
          return args.orderDir === "desc" ? valB.localeCompare(valA) : valA.localeCompare(valB);
        }
        return args.orderDir === "desc" ? valB - valA : valA - valB;
      });
    }
    return results;
  },
});

export const get = query({
  args: {
    table: v.string(),
    idField: v.optional(v.string()), // e.g. "id" or "email"
    idVal: v.any(),
  },
  handler: async (ctx, args) => {
    if (!args.idField || args.idField === "_id") {
      return await ctx.db.get(args.idVal);
    }
    return await ctx.db
      .query(args.table)
      .filter((q) => q.eq(q.field(args.idField), args.idVal))
      .first();
  },
});

export const insert = mutation({
  args: {
    table: v.string(),
    document: v.any(),
  },
  handler: async (ctx, args) => {
    const _id = await ctx.db.insert(args.table, args.document);
    return await ctx.db.get(_id);
  },
});

export const update = mutation({
  args: {
    table: v.string(),
    idField: v.optional(v.string()), // e.g. "id" or "email" or "_id"
    idVal: v.any(),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    let doc = null;
    if (!args.idField || args.idField === "_id") {
      doc = await ctx.db.get(args.idVal);
    } else {
      doc = await ctx.db
        .query(args.table)
        .filter((q) => q.eq(q.field(args.idField), args.idVal))
        .first();
    }
    if (!doc) {
      throw new Error(`Document not found in table ${args.table} for ${args.idField || "_id"} = ${args.idVal}`);
    }
    await ctx.db.patch(doc._id, args.patch);
    return await ctx.db.get(doc._id);
  },
});

export const remove = mutation({
  args: {
    table: v.string(),
    idField: v.optional(v.string()), // e.g. "id" or "_id"
    idVal: v.any(),
  },
  handler: async (ctx, args) => {
    let doc = null;
    if (!args.idField || args.idField === "_id") {
      doc = await ctx.db.get(args.idVal);
    } else {
      doc = await ctx.db
        .query(args.table)
        .filter((q) => q.eq(q.field(args.idField), args.idVal))
        .first();
    }
    if (!doc) return null;
    await ctx.db.delete(doc._id);
    return doc;
  },
});

export const bulkDelete = mutation({
  args: {
    table: v.string(),
    idField: v.string(), // e.g. "id" or "_id"
    idVals: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    let deletedCount = 0;
    for (const val of args.idVals) {
      let doc = null;
      if (args.idField === "_id") {
        doc = await ctx.db.get(val);
      } else {
        doc = await ctx.db
          .query(args.table)
          .filter((q) => q.eq(q.field(args.idField), val))
          .first();
      }
      if (doc) {
        await ctx.db.delete(doc._id);
        deletedCount++;
      }
    }
    return { deletedCount };
  },
});

export const bulkUpdate = mutation({
  args: {
    table: v.string(),
    idField: v.string(), // e.g. "id" or "_id"
    idVals: v.array(v.any()),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    let updatedCount = 0;
    for (const val of args.idVals) {
      let doc = null;
      if (args.idField === "_id") {
        doc = await ctx.db.get(val);
      } else {
        doc = await ctx.db
          .query(args.table)
          .filter((q) => q.eq(q.field(args.idField), val))
          .first();
      }
      if (doc) {
        await ctx.db.patch(doc._id, args.patch);
        updatedCount++;
      }
    }
    return { updatedCount };
  },
});

export const insertBatch = mutation({
  args: {
    table: v.string(),
    documents: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const ids = [];
    for (const doc of args.documents) {
      const _id = await ctx.db.insert(args.table, doc);
      ids.push(_id);
    }
    return ids;
  },
});

export const count = query({
  args: {
    table: v.string(),
    filter: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    let q = ctx.db.query(args.table);
    if (args.filter) {
      for (const [key, val] of Object.entries(args.filter)) {
        if (val !== undefined && val !== null) {
          q = q.filter((d) => d.eq(d.field(key), val));
        }
      }
    }
    const docs = await q.collect();
    return docs.length;
  },
});

export const syncTable = mutation({
  args: {
    table: v.string(),
    documents: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query(args.table).collect();
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of args.documents) {
      const cleanDoc = { ...doc };
      delete cleanDoc._id;
      delete cleanDoc._creationTime;
      await ctx.db.insert(args.table, cleanDoc);
    }
    return { success: true };
  },
});

