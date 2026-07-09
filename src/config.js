// Single source of truth for the API origin. Lives in its own module because both
// api.js and auth.js need it, and api.js already imports auth.js — sharing it from
// api.js would create a cycle.
//
// Set VITE_API_URL in the Vercel project settings, e.g.
//   VITE_API_URL=https://assetflow-api.up.railway.app/api
// Vite inlines it at build time, so a change requires a redeploy.
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// The API origin without the trailing /api, for the rare absolute link.
export const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');
