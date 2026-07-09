import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Search, BookOpen, Plus, Edit2, Trash2, ArrowLeft, Eye, HelpCircle,
  FileText, Paperclip, Send, EyeOff, Save, X
} from 'lucide-react';
import { api } from './api';
import { openStoredFile } from './files';
import Markdown from './Markdown';
import { silk } from './engine/motion';

const AUTHOR_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin'];

/* ------------------------------------------------------------------ editor */

const ArticleEditor = ({ article, categories, allArticles, onSave, onCancel, addToast }) => {
  const [title, setTitle] = useState(article?.title || '');
  const [summary, setSummary] = useState(article?.summary || '');
  const [body, setBody] = useState(article?.body || '');
  const [categoryId, setCategoryId] = useState(article?.category_id || '');
  const [isFaq, setIsFaq] = useState(article?.is_faq || false);
  const [isPublished, setIsPublished] = useState(article?.is_published || false);
  const [relatedIds, setRelatedIds] = useState((article?.related || []).map((r) => r.id));
  const [attachments, setAttachments] = useState(
    (article?.attachments || []).map((a) => ({ name: a.file_name, fileUrl: a.file_path, fileType: a.file_type, fileSize: a.file_size }))
  );
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const uploadAttachment = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.uploadFile(file);
      setAttachments((prev) => [...prev, { name: res.name, fileUrl: res.fileUrl, fileType: file.type, fileSize: res.fileSize }]);
      addToast('Attached', `${res.name} uploaded.`, 'success');
    } catch (err) {
      addToast('Upload failed', err.message, 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) {
      addToast('Missing fields', 'Title and body are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        summary: summary.trim() || null,
        body,
        categoryId: categoryId || null,
        isFaq,
        isPublished,
        relatedIds,
        attachments
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="form-grid">
        <div className="form-group full-width">
          <label className="form-label">Title</label>
          <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Summary</label>
          <input className="form-input" value={summary} onChange={(e) => setSummary(e.target.value)}
                 placeholder="One line shown in search results" />
        </div>
        <div className="form-group">
          <label className="form-label">Category</label>
          <select className="form-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Options</label>
          <div style={{ display: 'flex', gap: '18px', alignItems: 'center', minHeight: '38px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
              <input type="checkbox" checked={isFaq} onChange={(e) => setIsFaq(e.target.checked)} /> FAQ
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
              <input type="checkbox" checked={isPublished} onChange={(e) => setIsPublished(e.target.checked)} /> Published
            </label>
          </div>
        </div>
      </div>

      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label className="form-label">Body (Markdown)</label>
          <button type="button" className="btn btn-secondary" style={{ minHeight: '30px', padding: '4px 10px', fontSize: '12px' }}
                  onClick={() => setPreview((p) => !p)}>
            {preview ? <Edit2 size={13} /> : <Eye size={13} />}
            {preview ? 'Edit' : 'Preview'}
          </button>
        </div>
        {preview ? (
          <div className="card" style={{ minHeight: '240px', background: 'var(--bg-subtle)' }}>
            <Markdown>{body}</Markdown>
          </div>
        ) : (
          <textarea className="form-input" style={{ minHeight: '240px', fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}
                    value={body} onChange={(e) => setBody(e.target.value)} required
                    placeholder={'## Heading\n\nUse **bold**, `code`, - bullets and [links](https://example.com).'} />
        )}
      </div>

      <div className="form-group">
        <label className="form-label">Related articles</label>
        <div style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '8px' }}>
          {allArticles.filter((a) => a.id !== article?.id).length === 0 ? (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No other articles yet.</span>
          ) : (
            allArticles.filter((a) => a.id !== article?.id).map((a) => (
              <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px', fontSize: '12.5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={relatedIds.includes(a.id)}
                       onChange={(e) => setRelatedIds((prev) => e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id))} />
                {a.title}
              </label>
            ))
          )}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Attachments</label>
        <input type="file" onChange={uploadAttachment} disabled={uploading} className="form-input" />
        {attachments.length > 0 && (
          <div className="attachment-preview-grid">
            {attachments.map((a, i) => (
              <div key={i} className="attachment-preview-card" onClick={() => setAttachments((prev) => prev.filter((_, n) => n !== i))} title="Click to remove">
                <FileText className="attachment-file-icon" size={20} />
                <span className="attachment-file-name">{a.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}><X size={14} /> Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}><Save size={14} /> {saving ? 'Saving…' : 'Save article'}</button>
      </div>
    </form>
  );
};

/* ------------------------------------------------------------ article view */

const ArticleView = ({ article, onBack, onOpenRelated, canAuthor, onEdit, onDelete, onTogglePublish, addToast }) => (
  <motion.div {...silk.entrance} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
    <div className="page-header">
      <div className="page-title-section">
        <button className="btn btn-secondary" style={{ alignSelf: 'flex-start', marginBottom: '10px' }} onClick={onBack}>
          <ArrowLeft size={14} /> Back to Knowledge Base
        </button>
        <h1 className="page-title">{article.title}</h1>
        <span className="page-subtitle">{article.summary}</span>
      </div>
      {canAuthor && (
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={onTogglePublish}>
            {article.is_published ? <><EyeOff size={14} /> Unpublish</> : <><Send size={14} /> Publish</>}
          </button>
          <button className="btn btn-secondary" onClick={onEdit}><Edit2 size={14} /> Edit</button>
          <button className="btn btn-danger" onClick={onDelete}><Trash2 size={14} /> Delete</button>
        </div>
      )}
    </div>

    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
      {article.category_name && <span className="badge badge-assigned">{article.category_name}</span>}
      {article.is_faq && <span className="badge badge-available"><HelpCircle size={11} /> FAQ</span>}
      {!article.is_published && <span className="badge badge-under-maintenance">Draft</span>}
      <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
        {article.view_count} views · by {article.author_name || 'Unknown'} · updated {new Date(article.updated_at).toLocaleDateString()}
      </span>
    </div>

    <div className="card">
      <Markdown>{article.body}</Markdown>
    </div>

    {article.attachments?.length > 0 && (
      <div className="card">
        <span className="card-title"><Paperclip /> Attachments</span>
        <div className="attachment-preview-grid">
          {article.attachments.map((a) => (
            <div key={a.id} className="attachment-preview-card"
                 onClick={() => openStoredFile(a.file_path, (m) => addToast('Cannot open file', m, 'error'))}>
              <FileText className="attachment-file-icon" size={22} />
              <span className="attachment-file-name" title={a.file_name}>{a.file_name}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {article.related?.length > 0 && (
      <div className="card">
        <span className="card-title"><BookOpen /> Related articles</span>
        <div style={{ display: 'grid', gap: '8px' }}>
          {article.related.map((r) => (
            <button key={r.id} className="btn btn-secondary" style={{ justifyContent: 'flex-start' }}
                    onClick={() => onOpenRelated(r.id)}>
              <FileText size={14} /> {r.title}
            </button>
          ))}
        </div>
      </div>
    )}
  </motion.div>
);

/* -------------------------------------------------------------------- page */

const KnowledgeBasePage = ({ currentRole, addToast }) => {
  const [articles, setArticles] = useState([]);
  const [categories, setCategories] = useState([]);
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [faqOnly, setFaqOnly] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const [active, setActive] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | article object
  const [loading, setLoading] = useState(true);

  const canAuthor = AUTHOR_ROLES.includes(currentRole);

  const load = useCallback(async (opts = {}) => {
    try {
      const [arts, cats] = await Promise.all([
        api.getKbArticles({
          q: opts.q ?? query,
          categoryId: opts.categoryId ?? categoryId,
          faqOnly: (opts.faqOnly ?? faqOnly) ? 'true' : undefined,
          includeDrafts: (opts.showDrafts ?? showDrafts) && canAuthor ? 'true' : undefined
        }),
        api.getKbCategories()
      ]);
      setArticles(arts);
      setCategories(cats);
    } catch (err) {
      addToast('Error', err.message || 'Could not load the knowledge base.', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, categoryId, faqOnly, showDrafts, canAuthor, addToast]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Debounced search so each keystroke does not hit the database.
  useEffect(() => {
    const t = setTimeout(() => load(), 300);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [query, categoryId, faqOnly, showDrafts]);

  const openArticle = async (idOrSlug) => {
    try {
      setActive(await api.getKbArticle(idOrSlug));
      setEditing(null);
    } catch (err) {
      addToast('Error', err.message || 'Could not open the article.', 'error');
    }
  };

  const saveArticle = async (payload) => {
    try {
      if (editing === 'new') {
        const created = await api.createKbArticle(payload);
        addToast('Article created', `"${created.title}" saved.`, 'success');
        setEditing(null);
        await load();
        await openArticle(created.id);
      } else {
        await api.updateKbArticle(editing.id, payload);
        addToast('Article updated', `"${payload.title}" saved.`, 'success');
        setEditing(null);
        await load();
        await openArticle(editing.id);
      }
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    }
  };

  const togglePublish = async () => {
    try {
      await api.updateKbArticle(active.id, { isPublished: !active.is_published });
      addToast(active.is_published ? 'Unpublished' : 'Published', `"${active.title}" updated.`, 'success');
      await openArticle(active.id);
      await load();
    } catch (err) {
      addToast('Error', err.message, 'error');
    }
  };

  const removeArticle = async () => {
    if (!window.confirm(`Delete "${active.title}" permanently?`)) return;
    try {
      await api.deleteKbArticle(active.id);
      addToast('Deleted', `"${active.title}" removed.`, 'success');
      setActive(null);
      await load();
    } catch (err) {
      addToast('Error', err.message, 'error');
    }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div className="page-header">
          <div className="page-title-section">
            <h1 className="page-title">{editing === 'new' ? 'New article' : `Editing: ${editing.title}`}</h1>
            <span className="page-subtitle">Bodies are Markdown. Use the preview to check formatting.</span>
          </div>
        </div>
        <div className="card">
          <ArticleEditor
            article={editing === 'new' ? null : editing}
            categories={categories}
            allArticles={articles}
            onSave={saveArticle}
            onCancel={() => setEditing(null)}
            addToast={addToast}
          />
        </div>
      </div>
    );
  }

  if (active) {
    return (
      <ArticleView
        article={active}
        canAuthor={canAuthor}
        addToast={addToast}
        onBack={() => setActive(null)}
        onOpenRelated={openArticle}
        onEdit={() => setEditing(active)}
        onDelete={removeArticle}
        onTogglePublish={togglePublish}
      />
    );
  }

  const faqs = articles.filter((a) => a.is_faq);
  const rest = articles.filter((a) => !a.is_faq);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="page-header">
        <div className="page-title-section">
          <h1 className="page-title">Knowledge Base</h1>
          <span className="page-subtitle">Search solutions and FAQs before raising a ticket.</span>
        </div>
        {canAuthor && (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New article</button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="search-bar-container" style={{ height: '42px' }}>
          <Search className="search-icon" />
          <input className="search-bar" placeholder="Search articles, FAQs and standard solutions…"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="filters-row" style={{ marginTop: '12px' }}>
          <div className="filters-left">
            <span>Category</span>
            <select className="filter-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.article_count})</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', cursor: 'pointer' }}>
              <input type="checkbox" checked={faqOnly} onChange={(e) => setFaqOnly(e.target.checked)} /> FAQs only
            </label>
            {canAuthor && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={showDrafts} onChange={(e) => setShowDrafts(e.target.checked)} /> Include drafts
              </label>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-text" /></div>
      ) : articles.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><BookOpen size={22} /></div>
            <div className="empty-state-title">{query ? 'No articles match your search' : 'No articles yet'}</div>
            <div className="empty-state-desc">
              {query ? 'Try different words, or raise a ticket if you cannot find an answer.'
                     : canAuthor ? 'Create the first article to start building your knowledge base.'
                                 : 'Your administrators have not published any articles yet.'}
            </div>
          </div>
        </div>
      ) : (
        <>
          {faqs.length > 0 && !faqOnly && (
            <div className="card">
              <span className="card-title"><HelpCircle /> Frequently Asked Questions</span>
              <div style={{ display: 'grid', gap: '8px' }}>
                {faqs.map((a) => <ArticleRow key={a.id} article={a} onOpen={openArticle} />)}
              </div>
            </div>
          )}

          <div className="card">
            <span className="card-title"><BookOpen /> {faqOnly ? 'FAQs' : 'Articles'}</span>
            <div style={{ display: 'grid', gap: '8px' }}>
              {(faqOnly ? faqs : rest).map((a) => <ArticleRow key={a.id} article={a} onOpen={openArticle} />)}
              {!faqOnly && rest.length === 0 && (
                <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>All matching articles are FAQs.</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const ArticleRow = ({ article, onOpen }) => (
  <button className="doc-card" style={{ textAlign: 'left', border: '1px solid var(--border-color)' }} onClick={() => onOpen(article.id)}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>{article.title}</div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{article.summary}</div>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
        {article.is_faq && <span className="badge badge-available">FAQ</span>}
        {!article.is_published && <span className="badge badge-under-maintenance">Draft</span>}
      </div>
    </div>
    <div className="doc-footer">
      <span className="doc-size">{article.category_name || 'Uncategorised'}</span>
      <span className="doc-action"><Eye size={12} /> {article.view_count}</span>
    </div>
  </button>
);

export default KnowledgeBasePage;
