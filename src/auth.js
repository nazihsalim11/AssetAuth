import { API_BASE_URL } from './config';

export const mockAuthService = {
  /**
   * Embedded WorkOS authentication: posts email + password to the backend, which
   * authenticates against WorkOS (userManagement.authenticateWithPassword) and sets a
   * secure HTTP-only session cookie. No hosted redirect. Returns the session on
   * success; throws an Error (with `.code`) carrying a user-facing message otherwise.
   */
  login: async (email, password, rememberMe = false) => {
    localStorage.setItem('remember_me', rememberMe ? 'true' : 'false');
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || 'Sign in failed. Please try again.');
      err.code = data.code;
      throw err;
    }
    const storage = rememberMe ? localStorage : sessionStorage;
    storage.setItem('user_session', JSON.stringify(data.session));
    return data.session;
  },

  /**
   * Starts a WorkOS-managed password reset. Always resolves (the backend responds
   * generically so it never reveals whether an email is registered).
   */
  forgotPassword: async (email) => {
    const response = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Could not start the password reset. Please try again.');
    }
    return data;
  },

  /**
   * Restores active session from local cache (localStorage or sessionStorage).
   */
  getCurrentSession: () => {
    const local = localStorage.getItem('user_session');
    if (local) {
      try {
        return JSON.parse(local);
      } catch {
        localStorage.removeItem('user_session');
      }
    }
    const session = sessionStorage.getItem('user_session');
    if (session) {
      try {
        return JSON.parse(session);
      } catch {
        sessionStorage.removeItem('user_session');
      }
    }
    return null;
  },

  /**
   * Fetches fresh session details asynchronously from the backend WorkOS cookie.
   */
  fetchSession: async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/session`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        // Update local caches
        const rememberMe = localStorage.getItem('remember_me') === 'true';
        const storage = rememberMe ? localStorage : sessionStorage;
        storage.setItem('user_session', JSON.stringify(data.session));
        return data.session;
      } else {
        mockAuthService.clearLocalSession();
        return null;
      }
    } catch (err) {
      console.warn('Session verification failed:', err);
      return null;
    }
  },

  /**
   * getToken returns null because the session is managed via secure HTTP-only cookies.
   */
  getToken: () => {
    return null;
  },

  /**
   * Clears session from local caches.
   */
  clearLocalSession: () => {
    localStorage.removeItem('user_session');
    sessionStorage.removeItem('user_session');
  },

  /**
   * Terminate the session. The backend revokes the WorkOS session server-side (no
   * hosted redirect) and clears the secure cookie; here we clear the local caches.
   */
  logout: async () => {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (e) {
      console.warn('Backend logout call failed:', e);
    }
    mockAuthService.clearLocalSession();
  }
};
