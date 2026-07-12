// localStorage keys used by an earlier client-side-cache design. The app now reads
// straight from the API, so any values still parked under these keys are stale and
// must be purged (see clearCachedUserData in ../utils/cache).
export const LEGACY_CACHE_KEYS = [
  'db_assets', 'db_amcs', 'db_invoices', 'db_documents', 'db_movements',
  'db_logs', 'db_notifications', 'db_emails', 'db_users', 'db_assignments',
  'db_role_permissions', 'db_assignments_cache_version'
];
