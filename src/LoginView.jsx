import React, { useState, useEffect, useRef } from 'react';
import { Package, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { silk } from './engine/motion';
import { mockAuthService, DEMO_CREDENTIALS } from './auth';

export default function LoginView({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const usernameInputRef = useRef(null);

  // Autofocus the username field on mount
  useEffect(() => {
    if (usernameInputRef.current) {
      usernameInputRef.current.focus();
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;

    setError(null);
    setLoading(true);

    try {
      const session = await mockAuthService.login(username, password, rememberMe);
      onLoginSuccess(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = (e) => {
    e.preventDefault();
    alert("In this demo environment, please use the predefined credentials on the Demo Accounts card to log in. In production, this link will trigger a standard password reset flow.");
  };

  // Helper to quickly autofill demo credentials on click
  const handleAutofill = (cred) => {
    setUsername(cred.username);
    setPassword(cred.password);
    setError(null);
    if (usernameInputRef.current) {
      usernameInputRef.current.focus();
    }
  };

  // The demo-accounts panel exposes usernames and passwords, so it is shown only in
  // development. Production renders the login form alone, centred.
  const showDemo = import.meta.env.DEV;

  return (
    <div className={`login-layout-container ${showDemo ? 'with-demo' : ''}`}>
      {/* Spacer for centering the login form in a 3-column grid on desktop */}
      {showDemo && <div className="login-spacer-left" />}

      {/* 1. Main Login Form Card */}
      <motion.div className="login-card" {...silk.entrance}>
        <div className="login-header">
          <div className="login-logo">
            <Package size={24} />
          </div>
          <h1 className="login-app-title">AssetFlow</h1>
          <span className="login-app-subtitle">The Asset Ledger</span>
          <p className="login-welcome">Enter your credentials to access the organizational registry.</p>
        </div>

        {error && (
          <div className="login-error-alert" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-form-group">
            <label htmlFor="username" className="login-form-label">Username</label>
            <div className="login-input-wrapper">
              <input
                id="username"
                type="text"
                ref={usernameInputRef}
                className="login-input"
                placeholder="e.g. admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                required
                autoComplete="username"
              />
            </div>
          </div>

          <div className="login-form-group">
            <label htmlFor="password" className="login-form-label">Password</label>
            <div className="login-input-wrapper">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                className="login-input password-input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                className="login-pwd-toggle"
                onClick={() => setShowPassword(!showPassword)}
                disabled={loading}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="login-options-row">
            <label className="login-remember-me">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={loading}
              />
              <span>Remember Me</span>
            </label>
            
            <a href="#/forgot-password" onClick={handleForgotPassword} className="login-forgot-pwd">
              Forgot Password?
            </a>
          </div>

          <button
            type="submit"
            className="login-btn"
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="login-spinner"></span>
                <span>Authenticating Ledger...</span>
              </>
            ) : (
              <span>Sign In</span>
            )}
          </button>
        </form>
      </motion.div>

      {/* 2. Demo Credentials Side Card — development only */}
      {showDemo && (
      <motion.div className="demo-creds-card" {...silk.entrance} transition={{ ...silk.entrance.transition, delay: 0.1 }}>
        <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '4px' }}>
          <h2 className="demo-creds-title">Demo Accounts</h2>
          <p className="demo-creds-desc">Click any card below to automatically pre-fill credentials for that role context.</p>
        </div>

        <div className="demo-creds-list">
          {DEMO_CREDENTIALS.map((cred) => (
            <div
              key={cred.role}
              className="demo-cred-item"
              onClick={() => handleAutofill(cred)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  handleAutofill(cred);
                }
              }}
            >
              <div className="demo-cred-role">{cred.role}</div>
              <div className="demo-cred-details">
                <div>
                  <span className="demo-cred-label">Username:</span>{' '}
                  <span className="demo-cred-val">{cred.username}</span>
                </div>
                <div>
                  <span className="demo-cred-label">Password:</span>{' '}
                  <span className="demo-cred-val">{cred.password}</span>
                </div>
                <div>
                  <span className="demo-cred-label">Acting As:</span>{' '}
                  <span className="demo-cred-val" style={{ fontStyle: 'italic' }}>{cred.name}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
      )}
    </div>
  );
}
