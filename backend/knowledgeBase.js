/**
 * Knowledge Base routes.
 *
 * Article bodies are Markdown, never HTML: nothing the server stores is ever parsed
 * as markup, so there is no sanitisation step to get wrong. The client renders it.
 *
 * Search uses the generated `search_vector` column (title weighted above summary
 * above body), so ranking is done by Postgres rather than by scanning in JS.
 *
 * Visibility: anyone signed in reads *published* articles. Authors and admins see
 * drafts too. Only admins may create, edit, publish or delete.
 */

const db = require('./db');

const AUTHOR_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin'];
const TICKET_TYPES = ['Incident', 'Service Request', 'General Query', 'Purchase Request'];
const HELPDESK_DEPARTMENTS = ['IT', 'Administration', 'HR'];

const canAuthor = (user) => AUTHOR_ROLES.includes(user.role);

/** URL-safe, collision-free slug. */
const slugify = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'article';

async function uniqueSlug(base, excludeId = null) {
  let slug = base;
  let n = 1;
  for (;;) {
    const { rows } = await db.query(
      'SELECT id FROM kb_articles WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)',
      [slug, excludeId]
    );
    if (rows.length === 0) return slug;
    slug = `${base}-${++n}`;
  }
}

const withCategory = `
  SELECT a.*, c.name AS category_name
  FROM kb_articles a
  LEFT JOIN kb_categories c ON a.category_id = c.id
`;

async function loadAttachments(articleId) {
  const { rows } = await db.query(
    'SELECT id, file_name, file_path, file_type, file_size FROM kb_article_attachments WHERE article_id = $1 ORDER BY id',
    [articleId]
  );
  return rows;
}

async function loadRelated(articleId, includeDrafts) {
  const { rows } = await db.query(
    `SELECT a.id, a.slug, a.title, a.summary, a.is_published
     FROM kb_related_articles r
     JOIN kb_articles a ON a.id = r.related_article_id
     WHERE r.article_id = $1 ${includeDrafts ? '' : 'AND a.is_published = TRUE'}
     ORDER BY a.title`,
    [articleId]
  );
  return rows;
}

/** Replaces an article's related edges, writing both directions so the link is mutual. */
async function setRelated(client, articleId, relatedIds) {
  await client.query('DELETE FROM kb_related_articles WHERE article_id = $1 OR related_article_id = $1', [articleId]);
  const ids = [...new Set((relatedIds || []).map(Number).filter((n) => Number.isInteger(n) && n !== articleId))];
  for (const rid of ids) {
    await client.query(
      `INSERT INTO kb_related_articles (article_id, related_article_id) VALUES ($1,$2), ($2,$1)
       ON CONFLICT DO NOTHING`,
      [articleId, rid]
    );
  }
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
      const { rows } = await db.query(
        `SELECT c.*, COUNT(a.id) FILTER (WHERE a.is_published) ::int AS article_count
         FROM kb_categories c
         LEFT JOIN kb_articles a ON a.category_id = c.id
         GROUP BY c.id ORDER BY c.name`
      );
      res.json(rows);
    } catch (err) {
      console.error('GET /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not load categories: ' + err.message });
    }
  });

  app.post('/api/kb/categories', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    const { name, description, department } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    try {
      const { rows } = await db.query(
        'INSERT INTO kb_categories (name, description, department) VALUES ($1,$2,$3) RETURNING *',
        [name.trim(), description || null, department || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: `A category named "${name}" already exists.` });
      console.error('POST /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not create category: ' + err.message });
    }
  });

  app.delete('/api/kb/categories/:id', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    try {
      // Articles survive: category_id is ON DELETE SET NULL.
      const { rowCount } = await db.query('DELETE FROM kb_categories WHERE id = $1', [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Category not found' });
      res.json({ message: 'Category deleted. Its articles are now uncategorised.' });
    } catch (err) {
      console.error('DELETE /api/kb/categories failed:', err);
      res.status(500).json({ error: 'Could not delete category: ' + err.message });
    }
  });

  /* --------------------------------------------------------------- articles */

  // List / search. `q` runs full-text search; without it, browse by category.
  app.get('/api/kb/articles', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { q, categoryId, faqOnly, includeDrafts } = req.query;
    const wantDrafts = includeDrafts === 'true' && canAuthor(user);

    const filters = [];
    const params = [];
    if (!wantDrafts) filters.push('a.is_published = TRUE');
    if (categoryId) { params.push(categoryId); filters.push(`a.category_id = $${params.length}`); }
    if (faqOnly === 'true') filters.push('a.is_faq = TRUE');

    let rankSelect = '';
    let order = 'ORDER BY a.is_faq DESC, a.view_count DESC, a.title';
    if (q && q.trim()) {
      params.push(q.trim());
      rankSelect = `, ts_rank(a.search_vector, websearch_to_tsquery('english', $${params.length})) AS rank`;
      filters.push(`a.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
      order = 'ORDER BY rank DESC, a.view_count DESC';
    }

    try {
      const { rows } = await db.query(
        `SELECT a.id, a.slug, a.title, a.summary, a.category_id, a.is_faq, a.is_published,
                a.author_name, a.view_count, a.created_at, a.updated_at, c.name AS category_name
                ${rankSelect}
         FROM kb_articles a
         LEFT JOIN kb_categories c ON a.category_id = c.id
         ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
         ${order}
         LIMIT 100`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('GET /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not load articles: ' + err.message });
    }
  });

  // Typeahead used by the ticket form. Deliberately cheap: published only, top 5,
  // and it never 500s — a failing suggestion must not block ticket creation.
  app.get('/api/kb/suggest', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.json([]);

    try {
      const { rows } = await db.query(
        `SELECT id, slug, title, summary, is_faq,
                ts_rank(search_vector, websearch_to_tsquery('english', $1)) AS rank
         FROM kb_articles
         WHERE is_published = TRUE AND search_vector @@ websearch_to_tsquery('english', $1)
         ORDER BY rank DESC, view_count DESC
         LIMIT 5`,
        [q]
      );
      res.json(rows);
    } catch (err) {
      // websearch_to_tsquery rejects some inputs; an empty list is the right answer.
      console.warn('KB suggest failed for query %j: %s', q, err.message);
      res.json([]);
    }
  });

  // Fetch by slug or numeric id.
  app.get('/api/kb/articles/:idOrSlug', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { idOrSlug } = req.params;
    const isId = /^\d+$/.test(idOrSlug);

    try {
      const { rows } = await db.query(
        `${withCategory} WHERE ${isId ? 'a.id = $1::int' : 'a.slug = $1'}`,
        [isId ? parseInt(idOrSlug, 10) : idOrSlug]
      );
      const article = rows[0];
      if (!article) return res.status(404).json({ error: 'Article not found' });
      if (!article.is_published && !canAuthor(user)) {
        return res.status(404).json({ error: 'Article not found' });
      }

      // Count this read. A failed counter must not fail the read, so fall back to the
      // value we already have rather than propagating the error.
      let viewCount = article.view_count;
      try {
        const bumped = await db.query(
          'UPDATE kb_articles SET view_count = view_count + 1 WHERE id = $1 RETURNING view_count',
          [article.id]
        );
        viewCount = bumped.rows[0].view_count;
      } catch (err) {
        console.warn('Could not bump view_count:', err.message);
      }

      res.json({
        ...article,
        view_count: viewCount,
        attachments: await loadAttachments(article.id),
        related: await loadRelated(article.id, canAuthor(user))
      });
    } catch (err) {
      console.error('GET /api/kb/articles/:idOrSlug failed:', err);
      res.status(500).json({ error: 'Could not load article: ' + err.message });
    }
  });

  app.post('/api/kb/articles', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    const { title, summary, body, categoryId, isFaq, isPublished, relatedIds, attachments } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Body is required' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const slug = await uniqueSlug(slugify(title));
      const { rows } = await client.query(
        `INSERT INTO kb_articles (slug, title, summary, body, category_id, is_faq, is_published, author_id, author_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [slug, title.trim(), summary || null, body, categoryId || null,
         !!isFaq, !!isPublished, user.id, user.name]
      );
      const article = rows[0];

      await setRelated(client, article.id, relatedIds);
      for (const att of attachments || []) {
        await client.query(
          `INSERT INTO kb_article_attachments (article_id, file_name, file_path, file_type, file_size, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [article.id, att.name, att.fileUrl, att.fileType || null, att.fileSize || null, user.name]
        );
      }
      await client.query('COMMIT');
      res.status(201).json(article);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not create article: ' + err.message });
    } finally {
      client.release();
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
    const setClauses = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key] === '' ? null : req.body[key]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (req.body.title) {
      values.push(await uniqueSlug(slugify(req.body.title), id));
      setClauses.push(`slug = $${values.length}`);
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      let article;
      if (setClauses.length) {
        values.push(id);
        const { rows } = await client.query(
          `UPDATE kb_articles SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
          values
        );
        article = rows[0];
        if (!article) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Article not found' });
        }
      } else {
        const { rows } = await client.query('SELECT * FROM kb_articles WHERE id = $1', [id]);
        article = rows[0];
        if (!article) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Article not found' });
        }
      }

      if (req.body.relatedIds !== undefined) await setRelated(client, id, req.body.relatedIds);
      if (req.body.attachments !== undefined) {
        await client.query('DELETE FROM kb_article_attachments WHERE article_id = $1', [id]);
        for (const att of req.body.attachments || []) {
          await client.query(
            `INSERT INTO kb_article_attachments (article_id, file_name, file_path, file_type, file_size, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, att.name, att.fileUrl || att.file_path, att.fileType || null, att.fileSize || null, user.name]
          );
        }
      }

      await client.query('COMMIT');
      res.json(article);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not update article: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/kb/articles/:id', async (req, res) => {
    const user = requireAuthor(req, res);
    if (!user) return;
    try {
      const { rowCount } = await db.query('DELETE FROM kb_articles WHERE id = $1', [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Article not found' });
      res.json({ message: 'Article deleted' });
    } catch (err) {
      console.error('DELETE /api/kb/articles failed:', err);
      res.status(500).json({ error: 'Could not delete article: ' + err.message });
    }
  });
}

module.exports = { register, TICKET_TYPES, HELPDESK_DEPARTMENTS, AUTHOR_ROLES };
