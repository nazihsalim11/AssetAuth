/**
 * Knowledge Base routes.
 *
 * Article bodies are Markdown, never HTML: nothing the server stores is ever parsed
 * as markup, so there is no sanitisation step to get wrong. The client renders it.
 *
 * Search is reimplemented in JS inside Convex (backend/convex/knowledgeBase.js) since
 * Convex has no Postgres full-text search; title is weighted above summary above body.
 *
 * Visibility: anyone signed in reads *published* articles. Authors and admins see
 * drafts too. Only admins may create, edit, publish or delete.
 */

const { cq, cm } = require('./convexApi');

const AUTHOR_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin'];
const TICKET_TYPES = ['Incident', 'Service Request', 'General Query', 'Purchase Request'];
const HELPDESK_DEPARTMENTS = ['IT', 'Administration', 'HR'];

const canAuthor = (user) => AUTHOR_ROLES.includes(user.role);

const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

function cleanErr(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

function register(app, { requireUser }) {
  const requireAuthor = (req, res) => {
    const user = requireUser(req, res);
    if (!user) return null;
    if (!canAuthor(user)) {
      res.status(403).json({ error: 'Only administrators can manage knowledge base articles.' });
      return null;
    }
    return user;
  };

  // Static option lists, so the client and server never disagree about valid values.
  app.get('/api/helpdesk/options', (req, res) => {
    res.json({ ticketTypes: TICKET_TYPES, departments: HELPDESK_DEPARTMENTS });
  });

  /* ------------------------------------------------------------- categories */

  app.get('/api/kb/categories', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const rows = await cq('knowledgeBase:categories', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error('GET /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not load categories: ' + cleanErr(err) });
    }
  });

  app.post('/api/kb/categories', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    const { name, description, department } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    try {
      const created = await cm('knowledgeBase:createCategory', { name, description: description || null, department: department || null });
      res.status(201).json(stripSys(created));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('POST /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not create category: ' + msg });
    }
  });

  app.patch('/api/kb/categories/:id', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    const { name, description, department } = req.body;
    if (name !== undefined && (!name || !String(name).trim())) {
      return res.status(400).json({ error: 'Category name cannot be blank' });
    }
    try {
      const result = await cm('knowledgeBase:updateCategory', {
        id: Number(req.params.id),
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(department !== undefined ? { department } : {}),
      });
      if (result && result.notFound) return res.status(404).json({ error: 'Category not found' });
      res.json(stripSys(result));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('PATCH /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not update category: ' + msg });
    }
  });

  app.delete('/api/kb/categories/:id', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    try {
      const result = await cm('knowledgeBase:deleteCategory', { id: Number(req.params.id) });
      if (result.notFound) return res.status(404).json({ error: 'Category not found' });
      res.json({ message: 'Category deleted. Its articles are now uncategorised.' });
    } catch (err) {
      console.error('DELETE /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not delete category: ' + cleanErr(err) });
    }
  });

  /* --------------------------------------------------------------- articles */

  // List / search. `q` runs search; without it, browse by category.
  app.get('/api/kb/articles', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { q, categoryId, faqOnly, includeDrafts } = req.query;
    const wantDrafts = includeDrafts === 'true' && canAuthor(user);

    try {
      const rows = await cq('knowledgeBase:listArticles', {
        q: q || undefined,
        categoryId: categoryId || undefined,
        faqOnly: faqOnly === 'true',
        wantDrafts,
      });
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error('GET /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not load articles: ' + cleanErr(err) });
    }
  });

  // Typeahead used by the ticket form. Deliberately cheap and never 500s — a failing
  // suggestion must not block ticket creation.
  app.get('/api/kb/suggest', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.json([]);
    try {
      const rows = await cq('knowledgeBase:suggest', { q });
      res.json(rows.map(stripSys));
    } catch (err) {
      console.warn('KB suggest failed for query %j: %s', q, err.message);
      res.json([]);
    }
  });

  // Fetch by slug or numeric id.
  app.get('/api/kb/articles/:idOrSlug', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { idOrSlug } = req.params;
    const author = canAuthor(user);

    try {
      const article = await cq('knowledgeBase:getArticle', { idOrSlug, includeDrafts: author });
      if (!article) return res.status(404).json({ error: 'Article not found' });
      if (!article.is_published && !author) {
        return res.status(404).json({ error: 'Article not found' });
      }

      // Count this read. A failed counter must not fail the read.
      let viewCount = article.view_count;
      try {
        const bumped = await cm('knowledgeBase:bumpView', { id: article.id });
        if (bumped != null) viewCount = bumped;
      } catch (err) {
        console.warn('Could not bump view_count:', err.message);
      }

      res.json({ ...stripSys(article), view_count: viewCount });
    } catch (err) {
      console.error('GET /api/kb/articles/:idOrSlug failed:', err);
      res.status(500).json({ error: 'Could not load article: ' + cleanErr(err) });
    }
  });

  app.post('/api/kb/articles', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    const { title, summary, body, categoryId, isFaq, isPublished, relatedIds, attachments } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Body is required' });

    const doc = {
      title: title.trim(),
      summary: summary || null,
      body,
      category_id: categoryId || null,
      is_faq: !!isFaq,
      is_published: !!isPublished,
      author_id: user.id,
      author_name: user.name,
    };

    try {
      const article = await cm('knowledgeBase:createArticle', { doc, relatedIds, attachments, authorName: user.name });
      res.status(201).json(stripSys(article));
    } catch (err) {
      console.error('POST /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not create article: ' + cleanErr(err) });
    }
  });

  app.patch('/api/kb/articles/:id', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    const id = parseInt(req.params.id, 10);

    const columns = {
      title: 'title', summary: 'summary', body: 'body',
      categoryId: 'category_id', isFaq: 'is_faq', isPublished: 'is_published'
    };
    const patch = {};
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) patch[column] = req.body[key];
    }

    try {
      const result = await cm('knowledgeBase:updateArticle', {
        id,
        patch,
        newTitleForSlug: req.body.title || undefined,
        relatedIds: req.body.relatedIds,
        attachments: req.body.attachments,
        authorName: user.name,
      });
      if (result && result.notFound) return res.status(404).json({ error: 'Article not found' });
      res.json(stripSys(result));
    } catch (err) {
      console.error('PATCH /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not update article: ' + cleanErr(err) });
    }
  });

  app.delete('/api/kb/articles/:id', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    try {
      const result = await cm('knowledgeBase:deleteArticle', { id: Number(req.params.id) });
      if (result.notFound) return res.status(404).json({ error: 'Article not found' });
      res.json({ message: 'Article deleted' });
    } catch (err) {
      console.error('DELETE /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not delete article: ' + cleanErr(err) });
    }
  });
}

module.exports = { register, TICKET_TYPES, HELPDESK_DEPARTMENTS, AUTHOR_ROLES };
