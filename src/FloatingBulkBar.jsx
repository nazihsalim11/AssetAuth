import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

/**
 * The floating toolbar every bulk-selection surface should use.
 *
 * Two things it fixes once, for every caller:
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
 *    `.has-bulk-bar .page-container` turns that into bottom padding, so the bar
 *    never covers content. Padding is added below existing content, so nothing
 *    already on screen moves.
 *
 * The height is measured rather than hard-coded because the bar wraps onto extra
 * rows at narrow widths and under browser zoom.
 */
const FloatingBulkBar = ({ children, className = '' }) => {
  const barRef = useRef(null);

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

  return createPortal(
    <motion.div
      ref={barRef}
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className={`floating-bulk-bar ${className}`.trim()}
      role="toolbar"
      aria-label="Bulk actions"
    >
      {children}
    </motion.div>,
    document.body
  );
};

export default FloatingBulkBar;
