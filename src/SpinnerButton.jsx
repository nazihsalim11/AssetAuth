import React, { useState } from 'react';
import { Spinner } from './Spinner';

/**
 * The app-wide button for any action that talks to the backend. It guarantees the
 * three things every async control must do, so no call site has to reinvent them:
 *
 *   1. single-submit  — a click (or Enter) while a request is in flight is ignored;
 *   2. loading feedback — the button disables and shows a spinner + loading label;
 *   3. accessibility    — aria-busy is set while working.
 *
 * Two ways to drive it:
 *
 *   • Uncontrolled (onClick buttons): pass an async `onClick`. If it returns a
 *     promise, the button manages its own pending state for that promise's life.
 *     Sync onClicks never flash a spinner.
 *
 *   • Controlled (form submit buttons): pass `loading` yourself. Use this for
 *     `type="submit"` buttons, where the work is kicked off by the form's onSubmit
 *     rather than the button's onClick — pair it with useAsyncAction on the handler.
 */
export const SpinnerButton = ({
  onClick,
  loading: loadingProp,
  loadingText,
  disabled = false,
  icon: Icon,
  spinnerSize = 14,
  children,
  className = 'btn btn-primary',
  type = 'button',
  style,
  ...rest
}) => {
  const [pending, setPending] = useState(false);
  const isControlled = loadingProp !== undefined;
  const loading = isControlled ? loadingProp : pending;

  const handleClick = async (e) => {
    if (loading) return;               // hard guard against a second submit
    if (!onClick) return;
    // Controlled buttons let the parent own the pending flag; just forward.
    if (isControlled) return onClick(e);
    const result = onClick(e);
    // Only self-manage when the handler is actually async, so sync clicks
    // (opening a modal, toggling a filter) never show a spurious spinner.
    if (result && typeof result.then === 'function') {
      setPending(true);
      try { await result; } finally { setPending(false); }
    }
  };

  return (
    <button
      type={type}
      className={className}
      disabled={disabled || loading}
      onClick={handleClick}
      aria-busy={loading || undefined}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', ...style }}
      {...rest}
    >
      {loading ? <Spinner size={spinnerSize} /> : (Icon ? <Icon size={spinnerSize} /> : null)}
      <span>{loading && loadingText ? loadingText : children}</span>
    </button>
  );
};

export default SpinnerButton;
