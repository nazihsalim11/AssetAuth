// Who performed the request, for notification payloads. Falls back to 'System' when
// the route has no session (schedulers, internal calls). Bound to the auth extractor
// so route modules can share one definition.
module.exports = (authenticateRequest) => (req) => {
  const { user } = authenticateRequest(req);
  return (user && (user.name || user.email)) || 'System';
};
