import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Native Convex data layer for the document repository. Documents keep the mirrored
// snake_case shape: id (DOC-### sequence), name, type, file_size, upload_date,
// association, file_url, created_at.

const nowIso = () => new Date().toISOString();

// Mirror the old documents_doc_seq: next id is DOC- + zero-padded max+1.
function nextDocId(rows) {
  let max = 0;
  for (const r of rows) {
    const m = /^DOC-(\d+)$/.exec(String(r.id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `DOC-${String(max + 1).padStart(3, "0")}`;
}

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("documents").collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows;
  },
});

export const create = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    const rows = await ctx.db.query("documents").collect();
    const id = nextDocId(rows);
    const _id = await ctx.db.insert("documents", { id, created_at: nowIso(), ...doc });
    return await ctx.db.get(_id);
  },
});
