const { cq, cm } = require('../../convexApi');

// Convex system fields aren't part of the SQL row shape the frontend expects.
const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

// Documents API. Access is enforced server-side against the role_permissions matrix, so a
// role without documents:view cannot read the repository even by calling the API directly.
// Backed by native Convex (backend/convex/documents.js).
function register(app, { requireUser, roleAllows }) {
  app.get('/api/documents', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      if (!(await roleAllows(user.role, 'documents', 'view'))) {
        return res.status(403).json({ error: 'Your role is not permitted to view the Document Repository.' });
      }
      const rows = await cq('documents:listAll', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error('GET /api/documents failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + (err.message || err) });
    }
  });

  app.post('/api/documents', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      if (!(await roleAllows(user.role, 'documents', 'create'))) {
        return res.status(403).json({ error: 'Your role is not permitted to add documents.' });
      }
      const { name, type, size, uploadDate, association, fileUrl } = req.body;
      // Convex issues the id (DOC-### sequence); any client-supplied id is ignored.
      const doc = {
        name,
        type,
        file_size: size || '',
        upload_date: uploadDate,
        association: association || '',
        file_url: fileUrl || '',
      };
      const created = await cm('documents:create', { doc });
      res.status(201).json(stripSys(created));
    } catch (err) {
      console.error('POST /api/documents failed:', err);
      res.status(500).json({ error: 'Database insertion failed: ' + (err.message || err) });
    }
  });
}

module.exports = { register };
