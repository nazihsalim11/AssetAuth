import { useState, useRef, useCallback } from 'react';

/**
 * Wraps an async handler so it can only run one at a time and exposes a `pending`
 * flag for loading UI. Built for <form onSubmit> handlers, where a submit-button
 * spinner alone cannot stop a second Enter-key submission — the guard has to live
 * on the action itself.
 *
 *   const [submit, submitting] = useAsyncAction(async (e) => { ... });
 *   <form onSubmit={submit}> ... <SpinnerButton type="submit" loading={submitting} />
 *
 * A re-entrant call (double click, Enter while in flight) is dropped, not queued.
 * `pending` is always cleared in a finally, so the control re-enables whether the
 * action resolved, threw, or returned early.
 */
export function useAsyncAction(fn) {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const run = useCallback(async (...args) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      return await fn(...args);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [fn]);

  return [run, pending];
}

export default useAsyncAction;
