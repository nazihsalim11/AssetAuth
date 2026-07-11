import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X, ChevronUp } from 'lucide-react';
import { useAnchoredOverlay } from './useAnchoredOverlay';
import { useDismissableLayer } from './useDismissableLayer';

/**
 * The floating toolbar every bulk-selection surface should use.
 *
 * Three things it handles once, for every caller:
 *
 * 1. Portaled to <body>. The bar is `position: fixed`, but the page area is
 *    wrapped in a `motion.div` that animates `scale`/`y`. A transformed ancestor
 *    becomes the containing block for fixed descendants, so during a page
 *    transition the bar would be positioned against that ancestor rather than the
 *    viewport. Leaving the subtree is the only reliable fix.
 *
 * 2. It reserves its own space. A fixed bar sits on top of whatever is at the
 *    bottom of the page — typically the last table rows and the pagination
 *    controls. Its measured height is published as `--bulk-bar-height` and
 *    `.has-bulk-bar .page-container` turns that into bottom padding. Padding is
 *    added below existing content, so nothing already on screen moves.
 *
 * 3. Below `collapseBelow` the actions move into an overflow menu. Wrapping alone
 *    is not enough: four action groups wrap to ~40% of a 360x640 viewport, and a
 *    toolbar that eats half the screen is worse than one extra tap. The menu is a
 *    portaled overlay anchored to its trigger, so it flips above the bar and stays
 *    inside the viewport like every other overlay in the app.
 *
 * Pass `summary` (what is selected), `actions` (the controls), and `onClear`.
 * Plain `children` are still supported and always render inline.
 */

const useMediaQuery = (query) => {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
};

const FloatingBulkBar = ({
  summary,
  actions,
  onClear,
  children,
  className = '',
  // Below this the bar cannot hold its actions on one row (measured: a full set
  // needs ~1145px of bar, and the bar is capped at min(92vw, 1200px)), so they
  // move into the overflow menu rather than wrapping into a screen-eating stack.
  collapseBelow = 1280,
  actionsLabel = 'Actions'
}) => {
  const barRef = useRef(null);
  const moreRef = useRef(null);
  const panelRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const collapsed = useMediaQuery(`(max-width: ${collapseBelow - 1}px)`) && Boolean(actions);

  // Anchored to the bar, not to the trigger inside it. The bar sits at the bottom
  // of the viewport, so useAnchoredOverlay's flip puts the panel above it; anchoring
  // to the button would clear the button but still overlap the bar's top edge.
  // `align: 'end'` keeps the panel beside the trigger, which lives on the right.
  const panelStyle = useAnchoredOverlay(barRef, menuOpen && collapsed, {
    matchAnchorWidth: false,
    width: 280,
    align: 'end',
    gap: 8,
    maxHeight: 320
  });

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;

    const root = document.documentElement;
    document.body.classList.add('has-bulk-bar');

    const publishHeight = () => {
      root.style.setProperty('--bulk-bar-height', `${el.offsetHeight}px`);
    };
    publishHeight();

    const observer = new ResizeObserver(publishHeight);
    observer.observe(el);

    return () => {
      observer.disconnect();
      document.body.classList.remove('has-bulk-bar');
      root.style.removeProperty('--bulk-bar-height');
    };
  }, []);

  // Expanding the viewport past the breakpoint must not strand an open menu.
  useEffect(() => {
    if (!collapsed) setMenuOpen(false);
  }, [collapsed]);

  // Outside-click / Escape dismissal + the shared single-open registry. The panel
  // is portaled to <body>, so panelRef is passed alongside the trigger; without it
  // a click on an action would count as "outside" and close the menu before the
  // action's handler ran.
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismissableLayer(menuOpen, closeMenu, [moreRef, panelRef]);

  return createPortal(
    <>
      <motion.div
        ref={barRef}
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        className={`floating-bulk-bar ${collapsed ? 'is-collapsed' : ''} ${className}`.trim()}
        role="toolbar"
        aria-label="Bulk actions"
      >
        {summary}
        {children}

        {actions && (collapsed ? (
          <button
            ref={moreRef}
            type="button"
            className="btn btn-secondary bulk-more-btn"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            {actionsLabel}
            <ChevronUp size={14} className={menuOpen ? 'bulk-more-chevron is-open' : 'bulk-more-chevron'} />
          </button>
        ) : (
          <div className="bulk-actions">{actions}</div>
        ))}

        {onClear && (
          <button type="button" className="bulk-clear-btn" onClick={onClear} title="Deselect all" aria-label="Deselect all">
            <X size={16} />
          </button>
        )}
      </motion.div>

      {collapsed && menuOpen && (
        <div
          ref={panelRef}
          className="bulk-actions-panel"
          role="menu"
          style={panelStyle || { position: 'fixed', visibility: 'hidden' }}
        >
          {actions}
        </div>
      )}
    </>,
    document.body
  );
};

export default FloatingBulkBar;
