import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for the Knowledge Base. Postgres full-text search
// (search_vector / websearch_to_tsquery / ts_rank) has no Convex equivalent, so search is
// reimplemented in JS: AND-of-terms matching over title+summary+body, ranked with the same
// A/B/D field weighting (title 3, summary 2, body 1) the tsvector used.
//
// Mirrored snake_case shapes (all SERIAL ids):
//   kb_categories(id, name, description, department, created_at, updated_at)
//   kb_articles(id, slug, title, summary, body, category_id, is_faq, is_published,
//               author_id, author_name, view_count, created_at, updated_at)
//   kb_article_attachments(id, article_id, file_name, file_path, file_type, file_size, uploaded_by)
//   kb_related_articles(article_id, related_article_id)

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s ?? "").toLowerCase();
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const tokenize = (q) => norm(q).split(/[^a-z0-9]+/).filter(Boolean);

// AND semantics: every term must appear somewhere. Returns null (no match) or a rank.
function ftsRank(a, tokens) {
  const title = norm(a.title), summary = norm(a.summary), body = norm(a.body);
  const hay = `${title} ${summary} ${body}`;
  if (!tokens.every((t) => hay.includes(t))) return null;
  let rank = 0;
  for (const t of tokens) {
    if (title.includes(t)) rank += 3;
    if (summary.includes(t)) rank += 2;
    if (body.includes(t)) rank += 1;
  }
  return rank;
}

const slugify = (title) =>
  String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "article";

async function uniqueSlug(ctx, base, excludeId = null) {
  const slugs = new Set(
    (await ctx.db.query("kb_articles").collect())
      .filter((a) => excludeId == null || a.id !== excludeId)
      .map((a) => a.slug)
  );
  let slug = base, n = 1;
  while (slugs.has(slug)) slug = `${base}-${++n}`;
  return slug;
}

const findArticleById = (ctx, id) =>
  ctx.db.query("kb_articles").filter((q) => q.eq(q.field("id"), id)).first();

async function categoryName(ctx, categoryId) {
  if (categoryId == null) return null;
  const c = await ctx.db.query("kb_categories").filter((q) => q.eq(q.field("id"), categoryId)).first();
  return c ? c.name : null;
}

async function loadAttachments(ctx, articleId) {
  return (await ctx.db.query("kb_article_attachments").collect())
    .filter((r) => r.article_id === articleId)
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
    .map((r) => ({ id: r.id, file_name: r.file_name, file_path: r.file_path, file_type: r.file_type, file_size: r.file_size }));
}

async function loadRelated(ctx, articleId, includeDrafts) {
  const edges = (await ctx.db.query("kb_related_articles").collect()).filter((r) => r.article_id === articleId);
  const relIds = new Set(edges.map((e) => e.related_article_id));
  const arts = (await ctx.db.query("kb_articles").collect())
    .filter((a) => relIds.has(a.id) && (includeDrafts || a.is_published))
    .sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  return arts.map((a) => ({ id: a.id, slug: a.slug, title: a.title, summary: a.summary, is_published: a.is_published }));
}

// Rewrite an article's related edges in both directions so the link is mutual.
async function setRelated(ctx, articleId, relatedIds) {
  const existing = (await ctx.db.query("kb_related_articles").collect()).filter(
    (r) => r.article_id === articleId || r.related_article_id === articleId
  );
  for (const e of existing) await ctx.db.delete(e._id);

  const ids = [...new Set((relatedIds || []).map(Number).filter((n) => Number.isInteger(n) && n !== articleId))];
  for (const rid of ids) {
    await ctx.db.insert("kb_related_articles", { article_id: articleId, related_article_id: rid });
    await ctx.db.insert("kb_related_articles", { article_id: rid, related_article_id: articleId });
  }
}

// ---------------------------------------------------------------- queries

export const categories = query({
  args: {},
  handler: async (ctx) => {
    const cats = await ctx.db.query("kb_categories").collect();
    const articles = await ctx.db.query("kb_articles").collect();
    const counts = {};
    for (const a of articles) if (a.is_published) counts[a.category_id] = (counts[a.category_id] || 0) + 1;
    cats.sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
    return cats.map((c) => ({ ...c, article_count: counts[c.id] || 0 }));
  },
});

export const listArticles = query({
  args: {
    q: v.optional(v.string()), categoryId: v.optional(v.any()),
    faqOnly: v.optional(v.boolean()), wantDrafts: v.optional(v.boolean()),
  },
  handler: async (ctx, { q, categoryId, faqOnly, wantDrafts }) => {
    let rows = await ctx.db.query("kb_articles").collect();
    if (!wantDrafts) rows = rows.filter((a) => a.is_published);
    if (categoryId != null && categoryId !== "") rows = rows.filter((a) => String(a.category_id) === String(categoryId));
    if (faqOnly) rows = rows.filter((a) => a.is_faq);

    const tokens = q && q.trim() ? tokenize(q) : null;
    let ranked;
    if (tokens && tokens.length) {
      ranked = [];
      for (const a of rows) {
        const rank = ftsRank(a, tokens);
        if (rank !== null) ranked.push({ a, rank });
      }
      ranked.sort((x, y) => y.rank - x.rank || (y.a.view_count || 0) - (x.a.view_count || 0));
    } else {
      ranked = rows
        .sort(
          (x, y) =>
            (y.is_faq ? 1 : 0) - (x.is_faq ? 1 : 0) ||
            (y.view_count || 0) - (x.view_count || 0) ||
            norm(x.title).localeCompare(norm(y.title))
        )
        .map((a) => ({ a, rank: null }));
    }

    const catNames = new Map((await ctx.db.query("kb_categories").collect()).map((c) => [c.id, c.name]));
    return ranked.slice(0, 100).map(({ a, rank }) => ({
      id: a.id, slug: a.slug, title: a.title, summary: a.summary, category_id: a.category_id,
      is_faq: a.is_faq, is_published: a.is_published, author_name: a.author_name, view_count: a.view_count,
      created_at: a.created_at, updated_at: a.updated_at, category_name: catNames.get(a.category_id) ?? null,
      ...(rank !== null ? { rank } : {}),
    }));
  },
});

export const suggest = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const tokens = tokenize(q);
    if (!tokens.length) return [];
    const rows = await ctx.db.query("kb_articles").collect();
    const ranked = [];
    for (const a of rows) {
      if (!a.is_published) continue;
      const rank = ftsRank(a, tokens);
      if (rank !== null) ranked.push({ a, rank });
    }
    ranked.sort((x, y) => y.rank - x.rank || (y.a.view_count || 0) - (x.a.view_count || 0));
    return ranked.slice(0, 5).map(({ a }) => ({ id: a.id, slug: a.slug, title: a.title, summary: a.summary, is_faq: a.is_faq }));
  },
});

// Fetch by numeric id or slug, with category_name, attachments, related. Returns null if
// missing; drafts are returned so the route can apply its author-visibility rule.
export const getArticle = query({
  args: { idOrSlug: v.string(), includeDrafts: v.boolean() },
  handler: async (ctx, { idOrSlug, includeDrafts }) => {
    const isId = /^\d+$/.test(idOrSlug);
    const article = isId
      ? await findArticleById(ctx, parseInt(idOrSlug, 10))
      : await ctx.db.query("kb_articles").filter((q) => q.eq(q.field("slug"), idOrSlug)).first();
    if (!article) return null;
    return {
      ...article,
      category_name: await categoryName(ctx, article.category_id),
      attachments: await loadAttachments(ctx, article.id),
      related: await loadRelated(ctx, article.id, includeDrafts),
    };
  },
});

// ---------------------------------------------------------------- mutations

export const bumpView = mutation({
  args: { id: v.float64() },
  handler: async (ctx, { id }) => {
    const article = await findArticleById(ctx, id);
    if (!article) return null;
    const view_count = (article.view_count || 0) + 1;
    await ctx.db.patch(article._id, { view_count });
    return view_count;
  },
});

export const createCategory = mutation({
  args: { name: v.string(), description: v.optional(v.any()), department: v.optional(v.any()) },
  handler: async (ctx, { name, description, department }) => {
    const rows = await ctx.db.query("kb_categories").collect();
    if (rows.some((c) => norm(c.name).trim() === norm(name).trim())) {
      throw new ConvexError(`A category named "${name}" already exists.`);
    }
    const now = nowIso();
    const _id = await ctx.db.insert("kb_categories", {
      id: nextId(rows), name: name.trim(), description: description ?? null, department: department ?? null,
      created_at: now, updated_at: now,
    });
    return await ctx.db.get(_id);
  },
});

export const updateCategory = mutation({
  args: { id: v.float64(), name: v.optional(v.string()), description: v.optional(v.any()), department: v.optional(v.any()) },
  handler: async (ctx, { id, name, description, department }) => {
    const cat = await ctx.db.query("kb_categories").filter((q) => q.eq(q.field("id"), id)).first();
    if (!cat) return { notFound: true };
    if (name !== undefined && norm(name).trim() !== norm(cat.name).trim()) {
      const rows = await ctx.db.query("kb_categories").collect();
      if (rows.some((c) => c._id !== cat._id && norm(c.name).trim() === norm(name).trim())) {
        throw new ConvexError(`A category named "${name}" already exists.`);
      }
    }
    const patch = { updated_at: nowIso() };
    if (name !== undefined) patch.name = name.trim();
    if (description !== undefined) patch.description = description ?? null;
    if (department !== undefined) patch.department = department ?? null;
    await ctx.db.patch(cat._id, patch);
    return await ctx.db.get(cat._id);
  },
});

export const deleteCategory = mutation({
  args: { id: v.float64() },
  handler: async (ctx, { id }) => {
    const cat = await ctx.db.query("kb_categories").filter((q) => q.eq(q.field("id"), id)).first();
    if (!cat) return { notFound: true };
    // Articles survive: category_id is set null (ON DELETE SET NULL).
    const orphans = (await ctx.db.query("kb_articles").collect()).filter((a) => a.category_id === id);
    for (const a of orphans) await ctx.db.patch(a._id, { category_id: null, updated_at: nowIso() });
    await ctx.db.delete(cat._id);
    return { deleted: true };
  },
});

export const createArticle = mutation({
  args: { doc: v.any(), relatedIds: v.optional(v.any()), attachments: v.optional(v.any()), authorName: v.string() },
  handler: async (ctx, { doc, relatedIds, attachments, authorName }) => {
    const now = nowIso();
    const rows = await ctx.db.query("kb_articles").collect();
    const id = nextId(rows);
    const slug = await uniqueSlug(ctx, slugify(doc.title));
    const _id = await ctx.db.insert("kb_articles", {
      id, slug, view_count: 0, created_at: now, updated_at: now, ...doc,
    });
    await setRelated(ctx, id, relatedIds);

    let attRows = await ctx.db.query("kb_article_attachments").collect();
    for (const att of attachments || []) {
      const aid = nextId(attRows);
      const rec = {
        id: aid, article_id: id, file_name: att.name, file_path: att.fileUrl ?? att.file_path,
        file_type: att.fileType ?? null, file_size: att.fileSize ?? null, uploaded_by: authorName,
      };
      await ctx.db.insert("kb_article_attachments", rec);
      attRows = [...attRows, rec];
    }
    return await ctx.db.get(_id);
  },
});

export const updateArticle = mutation({
  args: {
    id: v.float64(), patch: v.any(), newTitleForSlug: v.optional(v.string()),
    relatedIds: v.optional(v.any()), attachments: v.optional(v.any()), authorName: v.string(),
  },
  handler: async (ctx, { id, patch, newTitleForSlug, relatedIds, attachments, authorName }) => {
    const article = await findArticleById(ctx, id);
    if (!article) return { notFound: true };

    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val === "" ? null : val;
    if (newTitleForSlug) clean.slug = await uniqueSlug(ctx, slugify(newTitleForSlug), id);
    if (Object.keys(clean).length) await ctx.db.patch(article._id, { ...clean, updated_at: nowIso() });

    if (relatedIds !== undefined) await setRelated(ctx, id, relatedIds);
    if (attachments !== undefined) {
      const old = (await ctx.db.query("kb_article_attachments").collect()).filter((r) => r.article_id === id);
      for (const o of old) await ctx.db.delete(o._id);
      let attRows = await ctx.db.query("kb_article_attachments").collect();
      for (const att of attachments || []) {
        const aid = nextId(attRows);
        const rec = {
          id: aid, article_id: id, file_name: att.name, file_path: att.fileUrl ?? att.file_path,
          file_type: att.fileType ?? null, file_size: att.fileSize ?? null, uploaded_by: authorName,
        };
        await ctx.db.insert("kb_article_attachments", rec);
        attRows = [...attRows, rec];
      }
    }
    return await ctx.db.get(article._id);
  },
});

export const deleteArticle = mutation({
  args: { id: v.float64() },
  handler: async (ctx, { id }) => {
    const article = await findArticleById(ctx, id);
    if (!article) return { notFound: true };
    const atts = (await ctx.db.query("kb_article_attachments").collect()).filter((r) => r.article_id === id);
    for (const a of atts) await ctx.db.delete(a._id);
    const edges = (await ctx.db.query("kb_related_articles").collect()).filter(
      (r) => r.article_id === id || r.related_article_id === id
    );
    for (const e of edges) await ctx.db.delete(e._id);
    await ctx.db.delete(article._id);
    return { deleted: true };
  },
});
