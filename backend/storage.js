/**
 * File storage.
 *
 * Production uses a PRIVATE Supabase Storage bucket: objects are unreachable
 * without a short-lived signed URL, which only an authenticated request can mint.
 * What we persist in the database is the object's *path* (e.g. `documents/x.pdf`),
 * never a URL — URLs expire, paths don't.
 *
 * When SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent (local dev) this falls
 * back to writing under backend/public/uploads and returns the legacy `/uploads/...`
 * path, so the app runs without any Supabase credentials.
 *
 * The service-role key bypasses row-level security. It must only ever live on the
 * server — never ship it to the browser.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
const SIGNED_URL_TTL_SECONDS = parseInt(process.env.SIGNED_URL_TTL_SECONDS || '120', 10);

const isRemote = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const client = isRemote
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

// Local fallback directory (also serves files uploaded before the Storage switch).
const uploadDir = path.join(__dirname, 'public/uploads');
if (!isRemote && !fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const LEGACY_PREFIX = '/uploads/';

/** A path written by the old disk-based uploader, still served by express.static. */
const isLegacyPath = (storagePath) => typeof storagePath === 'string' && storagePath.startsWith(LEGACY_PREFIX);

/** Strip anything that could escape the bucket prefix or confuse a URL. */
const safeObjectName = (originalName) => {
  const ext = path.extname(originalName).slice(0, 12);
  const base = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'file';
  return `${base}-${Date.now()}${ext}`;
};

/**
 * Persists a buffer and returns the durable reference to store in the database:
 * a bucket object path remotely, or a `/uploads/...` path locally.
 */
async function saveFile(buffer, originalName, contentType) {
  const objectName = safeObjectName(originalName);

  if (!isRemote) {
    fs.writeFileSync(path.join(uploadDir, objectName), buffer);
    return `${LEGACY_PREFIX}${objectName}`;
  }

  const objectPath = `uploads/${objectName}`;
  const { error } = await client.storage.from(BUCKET).upload(objectPath, buffer, {
    contentType: contentType || 'application/octet-stream',
    upsert: false
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return objectPath;
}

/**
 * Mints a short-lived URL for a stored object. Legacy `/uploads/...` paths are
 * served straight off this process, so they just need an absolute URL.
 */
async function getSignedUrl(storagePath, baseUrl) {
  if (!storagePath) throw new Error('A storage path is required');

  if (isLegacyPath(storagePath)) {
    if (isRemote) {
      // The disk these lived on does not exist in production.
      throw new Error('This file predates cloud storage and is no longer available.');
    }
    return `${baseUrl}${storagePath}`;
  }

  if (!isRemote) throw new Error('Cloud storage is not configured on this server');

  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw new Error(`Could not sign file URL: ${error.message}`);
  return data.signedUrl;
}

module.exports = {
  saveFile,
  getSignedUrl,
  isRemote,
  isLegacyPath,
  uploadDir,
  BUCKET,
  SIGNED_URL_TTL_SECONDS
};
