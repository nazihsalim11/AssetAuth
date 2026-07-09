import { API_BASE_URL } from './config';

// Predefined demo credentials matching the roles in the application
export const DEMO_CREDENTIALS = [
  {
    role: "Super Admin",
    username: "admin",
    password: "Admin@123",
    email: "admin@company.com",
    name: "Admin Operations"
  },
  {
    role: "IT Admin",
    username: "itadmin",
    password: "IT@123",
    email: "itadmin@company.com",
    name: "IT Operations"
  },
  {
    role: "Facility Admin",
    username: "facilityadmin",
    password: "Facility@123",
    email: "facilityadmin@company.com",
    name: "Facility Operations"
  },
  {
    role: "Finance Team",
    username: "finance",
    password: "Finance@123",
    email: "finance@company.com",
    name: "Finance Operations"
  },
  {
    role: "Employee",
    username: "employee",
    password: "Employee@123",
    email: "employee@company.com",
    name: "Alice Johnson"
  },
  {
    role: "Auditor",
    username: "auditor",
    password: "Auditor@123",
    email: "auditor@company.com",
    name: "Audit Team"
  }
];

export const mockAuthService = {
  /**
   * Authenticates user against backend API or falls back to local demo credentials.
   */
  login: async (username, password, rememberMe) => {
    if (!username || !password) {
      throw new Error("Please enter both username and password.");
    }

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (response.ok) {
        const data = await response.json();
        const session = data.session;
        // Clear both stores first. Otherwise a token remembered in localStorage
        // outlives a later sessionStorage login and shadows it in getToken(),
        // so requests go out signed as the *previous* user.
        mockAuthService.logout();
        const storage = rememberMe ? localStorage : sessionStorage;
        storage.setItem('user_session', JSON.stringify(session));
        storage.setItem('auth_token', data.token);
        return session;
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || "Invalid username or password.");
      }
    } catch (err) {
      // Fallback if the server is offline or unreachable
      if (err.message === "Failed to fetch" || err.name === "TypeError") {
        console.warn("API Server offline, falling back to local credentials...");
        
        // 1. Try demo credentials first
        const demoUser = DEMO_CREDENTIALS.find(
          u => u.username.toLowerCase() === username.toLowerCase() && u.password === password
        );
        if (demoUser) {
          const session = {
            username: demoUser.username,
            role: demoUser.role,
            name: demoUser.name,
            email: demoUser.email
          };
          const storage = rememberMe ? localStorage : sessionStorage;
          storage.setItem('user_session', JSON.stringify(session));
          return session;
        }

        // 2. Try users from local storage db_users
        const localUsersJson = localStorage.getItem('db_users');
        if (localUsersJson) {
          try {
            const localUsers = JSON.parse(localUsersJson);
            const user = localUsers.find(
              u => (u.username || '').toLowerCase() === username.toLowerCase()
            );

            if (user) {
              const expectedPassword = user.password || 'Password@123';
              if (password === expectedPassword) {
                const session = {
                  username: user.username,
                  role: user.role,
                  name: user.name,
                  email: user.email,
                  passwordResetRequired: user.passwordResetRequired
                };
                const storage = rememberMe ? localStorage : sessionStorage;
                storage.setItem('user_session', JSON.stringify(session));
                return session;
              }
            }
          } catch (e) {
            console.error("Failed to parse local users:", e);
          }
        }

        throw new Error("Invalid username or password.");
      } else {
        throw err;
      }
    }
  },

  /**
   * Restores active session from localStorage or sessionStorage.
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
   * Reads the JWT from whichever store holds the active session, so the token can
   * never belong to a different login than the session. Returns null for offline
   * demo sessions, which have no token.
   */
  getToken: () => {
    if (localStorage.getItem('user_session')) {
      return localStorage.getItem('auth_token');
    }
    if (sessionStorage.getItem('user_session')) {
      return sessionStorage.getItem('auth_token');
    }
    return null;
  },

  /**
   * Completely terminates session from client storage.
   */
  logout: () => {
    localStorage.removeItem('user_session');
    localStorage.removeItem('auth_token');
    sessionStorage.removeItem('user_session');
    sessionStorage.removeItem('auth_token');
  }
};
