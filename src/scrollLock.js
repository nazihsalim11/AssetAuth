/**
 * Background scroll lock, shared by every modal.
 *
 * Reference counted: with two modals stacked (an article preview over the ticket
 * form), closing the top one must not unlock the page while the one beneath is still
 * open. Only the transition 0 -> 1 locks, and only 1 -> 0 unlocks.
 *
 * Removing the scrollbar shrinks the viewport, so the page behind the overlay would
 * visibly jump sideways. We add the reclaimed width back as body padding.
 *
 * `doc`/`win` are injectable so the counting can be tested without a DOM.
 */

let openCount = 0;
let savedOverflow = '';
let savedPaddingRight = '';

export function lockBodyScroll(doc = typeof document !== 'undefined' ? document : null,
                              win = typeof window !== 'undefined' ? window : null) {
  if (openCount === 0 && doc && win) {
    const body = doc.body;
    const scrollbarWidth = win.innerWidth - doc.documentElement.clientWidth;
    savedOverflow = body.style.overflow;
    savedPaddingRight = body.style.paddingRight;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      const current = parseFloat(win.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbarWidth}px`;
    }
  }
  openCount += 1;
  return openCount;
}

export function unlockBodyScroll(doc = typeof document !== 'undefined' ? document : null) {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0 && doc) {
    doc.body.style.overflow = savedOverflow;
    doc.body.style.paddingRight = savedPaddingRight;
  }
  return openCount;
}

/** Test hook. */
export function _getOpenCount() {
  return openCount;
}

export function _reset() {
  openCount = 0;
  savedOverflow = '';
  savedPaddingRight = '';
}
