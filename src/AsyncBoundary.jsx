import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { PageSkeleton } from './Skeleton';
import { STATUS } from './asyncStatus';

/**
 * The one place a page decides between "still loading", "it failed", and "here is
 * the data". Every async surface should route through this rather than rendering
 * its own zeros.
 *
 * Three states, and the middle one is the whole reason this exists:
 *
 *   loading  -> a skeleton shaped like the eventual content
 *   error    -> what went wrong, and a Retry that re-runs the fetch
 *   ready    -> children
 *
 * A failed fetch used to leave the state arrays empty, so the dashboard rendered
 * `0 assets` and the tables rendered "No data". That is indistinguishable from a
 * healthy empty database, which means the user is told something false. An error
 * state is not a nicety here; it is the difference between "we could not ask" and
 * "the answer is none".
 *
 * `isEmpty` is deliberately separate: only a *completed* request may say "empty".
 */

export const ErrorState = ({
  title = 'Unable to connect to the backend',
  message,
  onRetry,
  isRetrying = false
}) => (
  <div className="empty-state" role="alert" style={{ minHeight: '280px' }}>
    <div className="empty-state-icon" style={{ color: 'var(--status-disposed)' }}>
      <AlertCircle size={30} />
    </div>
    <div className="empty-state-title">{title}</div>
    <div className="empty-state-desc">
      {message || 'The server did not respond. It may be starting up, or temporarily unavailable.'}
    </div>
    {onRetry && (
      <button
        className="btn btn-primary"
        onClick={onRetry}
        disabled={isRetrying}
        style={{ marginTop: 'var(--sp-4)' }}
      >
        <RefreshCw size={15} className={isRetrying ? 'animate-spin' : undefined} />
        {isRetrying ? 'Retrying…' : 'Retry'}
      </button>
    )}
  </div>
);

export const LoadingState = ({ label = 'Loading data…' }) => (
  <div className="empty-state" role="status" aria-busy="true" style={{ minHeight: '280px' }}>
    <div className="empty-state-icon" style={{ color: 'var(--primary)' }}>
      <RefreshCw size={30} className="animate-spin" />
    </div>
    <div className="empty-state-title">{label}</div>
  </div>
);

const AsyncBoundary = ({
  status,
  error,
  onRetry,
  isRetrying = false,
  skeleton,
  errorTitle,
  children
}) => {
  if (status === STATUS.LOADING) {
    return skeleton !== undefined ? skeleton : <PageSkeleton />;
  }

  if (status === STATUS.ERROR) {
    return (
      <ErrorState
        title={errorTitle}
        message={typeof error === 'string' ? error : error?.message}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    );
  }

  return children;
};

export default AsyncBoundary;
