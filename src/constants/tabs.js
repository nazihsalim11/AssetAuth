// Single source of truth for the hash routes an authenticated user can land on.
// Both the initial-state resolver and the hashchange handler read this, so a new
// tab can never be reachable on refresh yet silently ignored on in-app navigation
// (which is exactly how the SLA tab regressed: it was missing from the handler's
// copy of this list).
export const VALID_TABS = [
  'dashboard', 'assets', 'allocations', 'amc', 'finance', 'documents',
  'qr_lookup', 'reports', 'emails', 'users', 'tickets', 'sla', 'knowledge_base'
];
