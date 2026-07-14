const { WorkOS } = require('@workos-inc/node');
const jwt = require('jsonwebtoken');
const { cq, cm } = require('../../convexApi');
const emailChannel = require('../../notifications/channels/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function register(app, { JWT_SECRET }) {
  const workosApiKey = process.env.WORKOS_API_KEY;
  const workosClientId = process.env.WORKOS_CLIENT_ID;
  const workosRedirectUri = process.env.WORKOS_REDIRECT_URI || 'http://localhost:5173/api/auth/callback';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  // The single account that is bootstrapped as Super Admin on first sign-in. Every
  // other first-time WorkOS user is provisioned as an Employee; roles thereafter are
  // governed by the application database (see provisionAndIssueToken) and can only be
  // changed by a Super Admin through User Management.
  const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@company.com').toLowerCase();

  const workos = workosApiKey ? new WorkOS(workosApiKey) : null;

  if (!workos) {
    console.warn('[WorkOS Auth Warning] WORKOS_API_KEY is not configured in .env. WorkOS Auth will run in local compatibility mode.');
  }

  // Secure, HTTP-only session cookie carrying our own signed JWT. Shared by the
  // embedded password login and the (legacy) hosted callback so both mint identical
  // sessions.
  //
  // In production the frontend (e.g. Vercel) and API (e.g. Render) are on different
  // domains, so the cookie is cross-site: it MUST be SameSite=None; Secure or the
  // browser refuses to send it back, and the user appears logged out immediately.
  // Locally (same-origin over http) SameSite=Lax is correct and Secure must be off.
  const IS_PROD = process.env.NODE_ENV === 'production';
  const AUTH_COOKIE_OPTS = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
  };

  function setAuthCookie(res, token) {
    res.cookie('auth_token', token, { ...AUTH_COOKIE_OPTS, maxAge: 24 * 60 * 60 * 1000 });
  }

  // The WorkOS access token is a JWT; its `sid` claim is the AuthKit session id. We
  // stash it in our own session token so logout can revoke the WorkOS session.
  function sessionIdFromAccessToken(accessToken) {
    if (!accessToken) return null;
    try {
      const claims = jwt.decode(accessToken);
      return claims && claims.sid ? claims.sid : null;
    } catch (e) {
      console.warn('[WorkOS Auth] Could not decode access token for session id:', e.message);
      return null;
    }
  }

  // The shape the frontend stores as the active session. Mirrors GET /api/auth/session
  // so login and session-restore return identical data.
  function buildSessionPayload(user) {
    return {
      id: user.workos_user_id,
      role: user.role,
      name: user.name,
      email: user.email,
      employeeId: user.employee_id,
      phoneNumber: user.phone_number,
      department: user.department,
      designation: user.designation,
      location: user.location,
      managerId: user.manager_id,
      status: user.status,
      notificationPreferences: user.notification_preferences,
    };
  }

  // Resolve the application user profile for an authenticated WorkOS identity and mint
  // our session JWT. First-time users are auto-provisioned: the bootstrap admin becomes
  // Super Admin, everyone else Employee. Returning users keep whatever role the database
  // holds — role is never taken from WorkOS. Returns { token, dbUser }.
  async function provisionAndIssueToken({ userEmail, workosUserId, firstName, lastName, workosSessionId }) {
    // Bootstrap email becomes Super Admin on first sign-in; everyone else Employee. The
    // provision mutation only applies this role when inserting a new profile — returning
    // users keep whatever role the database holds. It also relinks a pre-seeded profile
    // to the real WorkOS id.
    const role = userEmail.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL ? 'Super Admin' : 'Employee';
    const fullName = `${firstName} ${lastName}`.trim() || userEmail.split('@')[0];
    const dbUser = await cm('users:provision', {
      workosUserId,
      email: userEmail,
      name: fullName,
      role,
    });

    const token = jwt.sign(
      {
        id: dbUser.workos_user_id,
        role: dbUser.role,
        name: dbUser.name,
        department: dbUser.department,
        email: dbUser.email,
        workosSessionId: workosSessionId || null,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return { token, dbUser };
  }

  // Reads and verifies our session JWT from the request (cookie or bearer header).
  function readSessionToken(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    if (req.headers.cookie) {
      const cookies = Object.fromEntries(
        req.headers.cookie.split(';').map(c => {
          const parts = c.trim().split('=');
          return [parts[0], parts.slice(1).join('=')];
        })
      );
      return cookies['auth_token'] || null;
    }
    return null;
  }

  // Maps a WorkOS authentication failure to a safe, user-facing response. Credential
  // failures are deliberately generic so we never confirm whether an email exists.
  function respondAuthError(res, err) {
    const code = (err && (err.code || (err.rawData && err.rawData.code))) || null;
    console.warn('[WorkOS Login] authentication failed:', code || err.message);

    if (code === 'email_verification_required') {
      return res.status(403).json({
        error: 'Please verify your email address before signing in. Check your inbox for a verification link.',
        code: 'EMAIL_VERIFICATION_REQUIRED',
      });
    }
    if (code === 'mfa_enrollment' || code === 'mfa_challenge' || code === 'authentication_challenge') {
      return res.status(403).json({
        error: 'This account requires multi-factor authentication, which is not available on this login yet. Contact your administrator.',
        code: 'MFA_REQUIRED',
      });
    }
    // A configuration problem (e.g. password auth disabled, bad client id) surfaces as a
    // non-401 from WorkOS; distinguish it so it is not mislabelled as bad credentials.
    if (err && err.status && err.status >= 500) {
      return res.status(502).json({
        error: 'The authentication service is temporarily unavailable. Please try again shortly.',
        code: 'AUTH_SERVICE_ERROR',
      });
    }
    return res.status(401).json({ error: 'Invalid email or password. Please try again.', code: 'INVALID_CREDENTIALS' });
  }

  // ---------------------------------------------------------------------------
  // Embedded password authentication (primary flow)
  // ---------------------------------------------------------------------------
  // POST /api/auth/login - Authenticates email + password directly against WorkOS
  // (userManagement.authenticateWithPassword) with no hosted redirect. WorkOS remains
  // the sole owner of credentials; we never see or store the password.
  app.post('/api/auth/login', async (req, res) => {
    const email = (req.body && req.body.email ? String(req.body.email) : '').trim();
    const password = req.body && req.body.password ? String(req.body.password) : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.', code: 'VALIDATION' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.', code: 'VALIDATION' });
    }
    if (!workos) {
      return res.status(503).json({
        error: 'Authentication is not configured on the server. Set WORKOS_API_KEY to enable sign-in.',
        code: 'AUTH_NOT_CONFIGURED',
      });
    }

    try {
      const response = await workos.userManagement.authenticateWithPassword({
        clientId: workosClientId,
        email,
        password,
      });
      const { user, accessToken } = response;
      const workosSessionId = sessionIdFromAccessToken(accessToken);

      const { token, dbUser } = await provisionAndIssueToken({
        userEmail: user.email,
        workosUserId: user.id,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        workosSessionId,
      });

      // Refuse a deactivated application profile even if WorkOS authenticated it.
      if (dbUser.status && (dbUser.status === 'Deactivated' || dbUser.status === 'Inactive')) {
        return res.status(403).json({
          error: 'Your account has been deactivated. Contact your administrator.',
          code: 'ACCOUNT_DEACTIVATED',
        });
      }

      setAuthCookie(res, token);
      return res.json({ session: buildSessionPayload(dbUser) });
    } catch (err) {
      return respondAuthError(res, err);
    }
  });

  // POST /api/auth/forgot-password - Starts a WorkOS-managed password reset and emails
  // the hosted reset link. Always responds success so it never reveals which addresses
  // are registered.
  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = (req.body && req.body.email ? String(req.body.email) : '').trim();
    const generic = {
      success: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    };

    if (!email) {
      return res.status(400).json({ error: 'Email is required.', code: 'VALIDATION' });
    }
    if (!workos) {
      return res.json(generic);
    }

    try {
      const reset = await workos.userManagement.createPasswordReset({ email });
      const resetUrl = reset && reset.passwordResetUrl;
      if (resetUrl) {
        if (emailChannel.isConfigured()) {
          await emailChannel.send({
            to: email,
            subject: 'Reset your AssetFlow password',
            body: `We received a request to reset your AssetFlow password.\n\n`
              + `Use the link below to choose a new password (it expires shortly):\n${resetUrl}\n\n`
              + `If you did not request this, you can safely ignore this email.`,
          }).catch((e) => console.warn('[Forgot Password] Email send failed:', e.message));
        } else {
          console.warn('[Forgot Password] SMTP is not configured; reset link not delivered for', email);
        }
      }
    } catch (err) {
      // Includes "user not found" — swallow so the response stays generic.
      console.warn('[Forgot Password] createPasswordReset failed:', err.message);
    }

    return res.json(generic);
  });

  // ---------------------------------------------------------------------------
  // Optional hosted redirect flow (real WorkOS AuthKit only — no demo/mock accounts)
  // ---------------------------------------------------------------------------
  // GET /api/auth/login-redirect - Initiates the WorkOS AuthKit hosted login redirect
  app.get('/api/auth/login-redirect', (req, res) => {
    if (!workos) {
      return res.status(503).send('Authentication is not configured. Set WORKOS_API_KEY.');
    }
    try {
      const authorizationUrl = workos.userManagement.getAuthorizationUrl({
        provider: 'authkit',
        redirectUri: workosRedirectUri,
        clientId: workosClientId,
      });
      res.redirect(authorizationUrl);
    } catch (err) {
      console.error('[WorkOS Redirect Error] Failed to generate AuthKit URL:', err);
      res.status(500).send(`Failed to redirect to WorkOS Auth: ${err.message}`);
    }
  });

  // GET /api/auth/callback - Exchanges a hosted-flow code for WorkOS user details
  app.get('/api/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
    if (!workos) {
      return res.status(503).send('Authentication is not configured. Set WORKOS_API_KEY.');
    }

    try {
      const response = await workos.userManagement.authenticateWithCode({
        clientId: workosClientId,
        code,
      });
      const { user, accessToken } = response;

      const { token } = await provisionAndIssueToken({
        userEmail: user.email,
        workosUserId: user.id,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        workosSessionId: sessionIdFromAccessToken(accessToken),
      });
      setAuthCookie(res, token);
      res.redirect(frontendUrl);
    } catch (err) {
      console.error('[WorkOS Callback Error] Authentication callback failed:', err);
      res.status(500).send(`Authentication failed: ${err.message}`);
    }
  });

  // GET /api/auth/session - Returns details of the active authenticated session
  app.get('/api/auth/session', async (req, res) => {
    const token = readSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'No active session', code: 'AUTH_REQUIRED' });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const dbUser = await cq('users:getByWorkosId', { workosUserId: decoded.id });
      if (!dbUser) {
        return res.status(401).json({ error: 'User record not found', code: 'TOKEN_INVALID' });
      }
      res.json({ token, session: buildSessionPayload(dbUser) });
    } catch (e) {
      const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      res.status(401).json({ error: 'Session expired or invalid. Please sign in again.', code });
    }
  });

  // POST /api/auth/logout - Ends the session: revokes the WorkOS session server-side
  // (no hosted redirect, so users never see a WorkOS page) and clears the local cookie.
  app.post('/api/auth/logout', async (req, res) => {
    const token = readSessionToken(req);
    if (token && workos) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.workosSessionId) {
          await workos.userManagement.revokeSession({ sessionId: decoded.workosSessionId });
        }
      } catch (e) {
        // Token missing/expired/invalid, or revoke failed: nothing more we can do —
        // clearing the local cookie below still ends the application session.
        if (e && e.message) console.warn('[Logout] WorkOS session revoke skipped:', e.message);
      }
    }

    res.clearCookie('auth_token', AUTH_COOKIE_OPTS);
    res.json({ success: true, message: 'Logged out successfully.' });
  });
}

module.exports = { register };
