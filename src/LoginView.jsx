import React, { useState } from 'react';
import { Package, AlertCircle, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { silk } from './engine/motion';
import { mockAuthService } from './auth';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginView({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  // Forgot-password sub-flow, shown inline within the same card.
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState(null);
  const [notice, setNotice] = useState(null);

  const validateLogin = () => {
    const errs = {};
    const value = email.trim();
    if (!value) {
      errs.email = 'Enter your email address.';
    } else if (!EMAIL_RE.test(value)) {
      errs.email = 'Enter a valid email address.';
    }
    if (!password) {
      errs.password = 'Enter your password.';
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (loading) return;
    setError(null);
    setNotice(null);
    if (!validateLogin()) return;

    setLoading(true);
    try {
      const session = await mockAuthService.login(email.trim(), password, rememberMe);
      onLoginSuccess?.(session);
    } catch (err) {
      setError(err.message || 'Sign in failed. Please try again.');
      setLoading(false);
    }
  };

  const handleForgotSubmit = async (e) => {
    if (e) e.preventDefault();
    if (forgotLoading) return;
    setForgotError(null);
    const value = forgotEmail.trim();
    if (!value || !EMAIL_RE.test(value)) {
      setForgotError('Enter a valid email address.');
      return;
    }
    setForgotLoading(true);
    try {
      const res = await mockAuthService.forgotPassword(value);
      setForgotMode(false);
      setForgotEmail('');
      setNotice(res.message || 'If an account exists for that email, a password reset link has been sent.');
    } catch (err) {
      setForgotError(err.message || 'Could not start the password reset. Please try again.');
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div className="login-layout-container">
      {/* Main Login Form Card */}
      <motion.div className="login-card" {...silk.entrance}>
        <div className="login-header">
          <div className="login-logo">
            <Package size={24} />
          </div>
          <h1 className="login-app-title">AssetFlow</h1>
          <span className="login-app-subtitle">The Asset Ledger</span>
          <p className="login-welcome">
            {forgotMode
              ? 'Enter your email and we’ll send you a link to reset your password.'
              : 'Sign in with your email and password to access the registry.'}
          </p>
        </div>

        {error && (
          <div className="login-error-alert" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            className="login-error-alert"
            role="status"
            style={{ background: 'rgba(22,163,74,0.10)', borderColor: 'rgba(22,163,74,0.35)', color: 'var(--success, #16a34a)' }}
          >
            <CheckCircle2 size={16} />
            <span>{notice}</span>
          </div>
        )}

        {!forgotMode ? (
          <form onSubmit={handleSubmit} className="login-form" noValidate>
            <div className="login-form-group">
              <label className="login-form-label" htmlFor="login-email">Email</label>
              <div className="login-input-wrapper">
                <input
                  id="login-email"
                  type="email"
                  className="login-input"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  autoComplete="email"
                  autoFocus
                  aria-label="Email address"
                  aria-invalid={!!fieldErrors.email}
                />
              </div>
              {fieldErrors.email && (
                <span className="login-field-error" style={{ color: 'var(--danger, #dc2626)', fontSize: '12px' }}>
                  {fieldErrors.email}
                </span>
              )}
            </div>

            <div className="login-form-group">
              <label className="login-form-label" htmlFor="login-password">Password</label>
              <div className="login-input-wrapper">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  className="login-input password-input"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  autoComplete="current-password"
                  aria-label="Password"
                  aria-invalid={!!fieldErrors.password}
                />
                <button
                  type="button"
                  className="login-pwd-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  disabled={loading}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {fieldErrors.password && (
                <span className="login-field-error" style={{ color: 'var(--danger, #dc2626)', fontSize: '12px' }}>
                  {fieldErrors.password}
                </span>
              )}
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
              <a
                href="#"
                className="login-forgot-pwd"
                onClick={(e) => {
                  e.preventDefault();
                  setError(null);
                  setNotice(null);
                  setForgotEmail(email.trim());
                  setForgotMode(true);
                }}
              >
                Forgot Password?
              </a>
            </div>

            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? (
                <>
                  <span className="login-spinner"></span>
                  <span>Signing in…</span>
                </>
              ) : (
                <span>Sign In</span>
              )}
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgotSubmit} className="login-form" noValidate>
            {forgotError && (
              <div className="login-error-alert" role="alert">
                <AlertCircle size={16} />
                <span>{forgotError}</span>
              </div>
            )}
            <div className="login-form-group">
              <label className="login-form-label" htmlFor="forgot-email">Email</label>
              <div className="login-input-wrapper">
                <input
                  id="forgot-email"
                  type="email"
                  className="login-input"
                  placeholder="you@company.com"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  disabled={forgotLoading}
                  autoComplete="email"
                  aria-label="Email address"
                  autoFocus
                />
              </div>
            </div>

            <button type="submit" className="login-btn" disabled={forgotLoading}>
              {forgotLoading ? (
                <>
                  <span className="login-spinner"></span>
                  <span>Sending…</span>
                </>
              ) : (
                <span>Send Reset Link</span>
              )}
            </button>

            <div className="login-options-row" style={{ justifyContent: 'center' }}>
              <a
                href="#"
                className="login-forgot-pwd"
                onClick={(e) => {
                  e.preventDefault();
                  setForgotMode(false);
                  setForgotError(null);
                }}
              >
                Back to sign in
              </a>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  );
}
