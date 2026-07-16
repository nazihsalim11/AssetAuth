import { query, mutation } from "./_generated/server";
import { ConvexError } from "convex/values";
import { v } from "convex/values";

/**
 * Requests data layer — the generic approval engine's storage.
 *
 * Deliberately knows nothing about *what* is being approved. A request row carries a
 * `request_type` that keys into backend/src/requests/registry.js; everything type-specific
 * (which record, which fields, how to apply an approved change) lives there. That is what
 * lets a new workflow be a registry entry instead of a new table and a new approval path.
 *
 * Concurrency: `act` takes the caller's `expectedUpdatedAt` and refuses if the row moved on.
 * Without it, two approvers clicking Approve at the same moment both read level 1, both
 * write level 2, and one approval is silently lost — or worse, a final approval applies the
 * change twice. A Convex mutation is a serializable transaction, so the compare-and-set here
 * is sufficient; callers surface the conflict as a 409.
 *
 * request_history is append-only. Nothing in this file updates or deletes a history row —
 * that is the audit guarantee the Requests module rests on.
 */

const nowIso = () => new Date().toISOString();
const nextRowId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const strip = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

const findRequest = (ctx, id) =>
  ctx.db.query("requests").filter((q) => q.eq(q.field("id"), id)).first();

const childrenOf = async (ctx, table, requestId) => {
  const rows = await ctx.db
    .query(table)
    .filter((q) => q.eq(q.field("request_id"), requestId))
    .collect();
  rows.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return rows;
};

/** Append one audit line. The only writer of request_history anywhere. */
async function appendHistory(ctx, requestId, entry) {
  const rows = await ctx.db.query("request_history").collect();
  await ctx.db.insert("request_history", {
    id: nextRowId(rows),
    request_id: requestId,
    action: entry.action,
    detail: entry.detail ?? null,
    actor: entry.actor ?? null,
    actor_name: entry.actorName ?? null,
    changes: entry.changes ?? null,
    from_status: entry.fromStatus ?? null,
    to_status: entry.toStatus ?? null,
    created_at: nowIso(),
  });
}

/* ------------------------------------------------------------------ queries */

export const list = query({
  args: {
    status: v.optional(v.array(v.string())),
    requestType: v.optional(v.string()),
    module: v.optional(v.string()),
    requestedBy: v.optional(v.string()),
    approverId: v.optional(v.string()),
    recordId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db.query("requests").collect();

    if (args.status?.length) rows = rows.filter((r) => args.status.includes(r.status));
    if (args.requestType) rows = rows.filter((r) => r.request_type === args.requestType);
    if (args.module) rows = rows.filter((r) => r.module === args.module);
    if (args.requestedBy) rows = rows.filter((r) => String(r.requested_by) === String(args.requestedBy));
    if (args.recordId) rows = rows.filter((r) => String(r.record_id) === String(args.recordId));
    // "Awaiting my approval": assigned at the level the request is actually sitting on, and
    // still Pending. An approver at level 2 should not see it while level 1 is undecided.
    if (args.approverId) {
      rows = rows.filter((r) =>
        (r.approvers || []).some(
          (a) =>
            String(a.user_id) === String(args.approverId) &&
            a.status === "Pending" &&
            Number(a.level) === Number(r.current_level)
        )
      );
    }

    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows.map(strip);
  },
});

export const detail = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const request = await findRequest(ctx, id);
    if (!request) return null;
    const [comments, attachments, history] = await Promise.all([
      childrenOf(ctx, "request_comments", id),
      childrenOf(ctx, "request_attachments", id),
      childrenOf(ctx, "request_history", id),
    ]);
    return {
      request: strip(request),
      comments: comments.map(strip),
      attachments: attachments.map(strip),
      history: history.map(strip),
    };
  },
});

/** Open requests already targeting a record — used to block a second edit request on it. */
export const openForRecord = query({
  args: { module: v.string(), recordId: v.string(), requestType: v.optional(v.string()) },
  handler: async (ctx, { module, recordId, requestType }) => {
    const open = ["Draft", "Pending Approval", "Under Review"];
    const rows = await ctx.db
      .query("requests")
      .filter((q) => q.eq(q.field("module"), module))
      .collect();
    return rows
      .filter(
        (r) =>
          String(r.record_id) === String(recordId) &&
          open.includes(r.status) &&
          (!requestType || r.request_type === requestType)
      )
      .map(strip);
  },
});

/* ---------------------------------------------------------------- mutations */

// Request + its attachments + the creation audit line, in one transaction: a request can
// never exist without its history, and a half-attached request can never be reviewed.
export const create = mutation({
  args: {
    request: v.any(),
    attachments: v.optional(v.array(v.any())),
  },
  handler: async (ctx, { request, attachments }) => {
    const existing = await findRequest(ctx, request.id);
    if (existing) throw new ConvexError(`Request '${request.id}' already exists.`);

    const now = nowIso();
    const doc = { ...request, created_at: now, updated_at: now };
    const _id = await ctx.db.insert("requests", doc);

    if (attachments?.length) {
      const rows = await ctx.db.query("request_attachments").collect();
      let next = nextRowId(rows);
      for (const a of attachments) {
        await ctx.db.insert("request_attachments", {
          id: next++,
          request_id: request.id,
          file_name: a.fileName ?? a.name ?? "attachment",
          file_path: a.filePath ?? a.fileUrl ?? null,
          file_type: a.fileType ?? null,
          file_size: a.fileSize ?? null,
          doc_type: a.docType ?? null,
          uploaded_by: a.uploadedBy ?? request.requested_by_name ?? null,
          created_at: now,
        });
      }
    }

    await appendHistory(ctx, request.id, {
      action: "Request Created",
      detail: `${request.request_type} raised against ${request.record_label || request.record_id}`,
      actor: request.requested_by,
      actorName: request.requested_by_name,
      changes: request.changes_preview ?? null,
      toStatus: request.status,
    });

    return strip(await ctx.db.get(_id));
  },
});

/**
 * Compare-and-set the request row and append one audit line. `expectedUpdatedAt` is the
 * caller's view of the row; a mismatch means someone else acted first and this action is
 * rejected rather than silently overwriting theirs.
 */
export const act = mutation({
  args: {
    id: v.string(),
    expectedUpdatedAt: v.string(),
    patch: v.any(),
    history: v.any(),
  },
  handler: async (ctx, { id, expectedUpdatedAt, patch, history }) => {
    const request = await findRequest(ctx, id);
    if (!request) throw new ConvexError(`Request '${id}' not found.`);
    if (String(request.updated_at) !== String(expectedUpdatedAt)) {
      throw new ConvexError(
        "This request was updated by someone else while you were reviewing it. Reload and try again."
      );
    }

    await ctx.db.patch(request._id, { ...patch, updated_at: nowIso() });
    await appendHistory(ctx, id, { ...history, fromStatus: request.status, toStatus: patch.status ?? request.status });
    return strip(await ctx.db.get(request._id));
  },
});

export const addComment = mutation({
  args: { id: v.string(), body: v.string(), actor: v.optional(v.string()), actorName: v.string() },
  handler: async (ctx, { id, body, actor, actorName }) => {
    const request = await findRequest(ctx, id);
    if (!request) throw new ConvexError(`Request '${id}' not found.`);

    const rows = await ctx.db.query("request_comments").collect();
    const now = nowIso();
    const _id = await ctx.db.insert("request_comments", {
      id: nextRowId(rows),
      request_id: id,
      body,
      author: actor ?? null,
      author_name: actorName,
      created_at: now,
    });
    await ctx.db.patch(request._id, { updated_at: now });
    await appendHistory(ctx, id, {
      action: "Comment Added",
      detail: body.length > 140 ? `${body.slice(0, 137)}…` : body,
      actor,
      actorName,
    });
    return strip(await ctx.db.get(_id));
  },
});

export const addAttachment = mutation({
  args: { id: v.string(), attachment: v.any(), actorName: v.string(), actor: v.optional(v.string()) },
  handler: async (ctx, { id, attachment, actorName, actor }) => {
    const request = await findRequest(ctx, id);
    if (!request) throw new ConvexError(`Request '${id}' not found.`);

    const rows = await ctx.db.query("request_attachments").collect();
    const now = nowIso();
    const _id = await ctx.db.insert("request_attachments", {
      id: nextRowId(rows),
      request_id: id,
      file_name: attachment.fileName ?? attachment.name ?? "attachment",
      file_path: attachment.filePath ?? attachment.fileUrl ?? null,
      file_type: attachment.fileType ?? null,
      file_size: attachment.fileSize ?? null,
      doc_type: attachment.docType ?? null,
      uploaded_by: actorName,
      created_at: now,
    });
    await ctx.db.patch(request._id, { updated_at: now });
    await appendHistory(ctx, id, {
      action: "Attachment Added",
      detail: attachment.fileName ?? attachment.name ?? "attachment",
      actor,
      actorName,
    });
    return strip(await ctx.db.get(_id));
  },
});

// Replace swaps the stored file but keeps the attachment row (and therefore its place in
// the history), so "replaced the wrong quote with the right one" stays one traceable item.
export const replaceAttachment = mutation({
  args: {
    id: v.string(),
    attachmentId: v.float64(),
    attachment: v.any(),
    actorName: v.string(),
    actor: v.optional(v.string()),
  },
  handler: async (ctx, { id, attachmentId, attachment, actorName, actor }) => {
    const request = await findRequest(ctx, id);
    if (!request) throw new ConvexError(`Request '${id}' not found.`);
    const row = await ctx.db
      .query("request_attachments")
      .filter((q) => q.eq(q.field("id"), attachmentId))
      .first();
    if (!row || row.request_id !== id) throw new ConvexError("Attachment not found on this request.");

    const previous = row.file_name;
    await ctx.db.patch(row._id, {
      file_name: attachment.fileName ?? attachment.name ?? row.file_name,
      file_path: attachment.filePath ?? attachment.fileUrl ?? row.file_path,
      file_type: attachment.fileType ?? row.file_type,
      file_size: attachment.fileSize ?? row.file_size,
      uploaded_by: actorName,
      updated_at: nowIso(),
    });
    await ctx.db.patch(request._id, { updated_at: nowIso() });
    await appendHistory(ctx, id, {
      action: "Attachment Replaced",
      detail: `${previous} → ${attachment.fileName ?? attachment.name ?? previous}`,
      actor,
      actorName,
    });
    return strip(await ctx.db.get(row._id));
  },
});

export const removeAttachment = mutation({
  args: { id: v.string(), attachmentId: v.float64(), actorName: v.string(), actor: v.optional(v.string()) },
  handler: async (ctx, { id, attachmentId, actorName, actor }) => {
    const request = await findRequest(ctx, id);
    if (!request) throw new ConvexError(`Request '${id}' not found.`);
    const row = await ctx.db
      .query("request_attachments")
      .filter((q) => q.eq(q.field("id"), attachmentId))
      .first();
    if (!row || row.request_id !== id) return null;

    await ctx.db.delete(row._id);
    await ctx.db.patch(request._id, { updated_at: nowIso() });
    await appendHistory(ctx, id, {
      action: "Attachment Deleted",
      detail: row.file_name,
      actor,
      actorName,
    });
    return strip(row);
  },
});

// Hard delete, gated on `requests.delete` in the route. Children go too — an orphaned
// history row referencing a request that no longer exists is noise, not an audit trail.
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const request = await findRequest(ctx, id);
    if (!request) return null;
    for (const table of ["request_comments", "request_attachments", "request_history"]) {
      for (const row of await childrenOf(ctx, table, id)) await ctx.db.delete(row._id);
    }
    await ctx.db.delete(request._id);
    return strip(request);
  },
});
