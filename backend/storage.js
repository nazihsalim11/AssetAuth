const fs = require('fs');
const path = require('path');
const { ConvexHttpClient } = require('convex/browser');
require('dotenv').config();

const convexUrl = process.env.CONVEX_URL;
const isRemote = Boolean(convexUrl);
const client = isRemote ? new ConvexHttpClient(convexUrl) : null;

// Local fallback directory
const uploadDir = path.join(__dirname, 'public/uploads');
if (!isRemote && !fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const LEGACY_PREFIX = '/uploads/';
const isLegacyPath = (storagePath) => typeof storagePath === 'string' && storagePath.startsWith(LEGACY_PREFIX);

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
 * a storage ID remotely via Convex, or a `/uploads/...` path locally.
 */
async function saveFile(buffer, originalName, contentType) {
  const objectName = safeObjectName(originalName);

  if (!isRemote) {
    fs.writeFileSync(path.join(uploadDir, objectName), buffer);
    return `${LEGACY_PREFIX}${objectName}`;
  }

  // 1. Get Convex upload URL
  const uploadUrl = await client.mutation("storage:generateUploadUrl");

  // 2. Upload file via POST request
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    body: buffer,
  });

  if (!response.ok) {
    throw new Error(`Convex storage upload failed: ${response.statusText}`);
  }

  const { storageId } = await response.json();
  return storageId;
}

/**
 * Mints a short-lived URL for a stored object.
 */
async function getSignedUrl(storagePath, baseUrl) {
  if (!storagePath) throw new Error('A storage path is required');

  if (isLegacyPath(storagePath)) {
    if (isRemote) {
      throw new Error('This file predates cloud storage and is no longer available.');
    }
    return `${baseUrl}${storagePath}`;
  }

  if (!isRemote) throw new Error('Cloud storage is not configured on this server');

  const fileUrl = await client.query("storage:getUrl", { storageId: storagePath });
  if (!fileUrl) throw new Error(`Could not resolve Convex storage URL for ID ${storagePath}`);
  return fileUrl;
}

module.exports = {
  saveFile,
  getSignedUrl,
  isRemote,
  isLegacyPath,
  uploadDir,
};
