import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * Positions a floating overlay against an anchor element.
 *
 * Every overlay in the app (dropdown menus, popovers, and anything added later)
 * should render through a portal to <body> and take its coordinates from here,
 * rather than being absolutely positioned inside its trigger. An absolutely
 * positioned overlay is still part of its ancestor's layout box: any ancestor
 * with `overflow: auto` — `.table-container` and `.modal-body` both qualify —
 * clips it and counts it toward that ancestor's scrollHeight, which spawns a
 * nested scrollbar. The scrollbar then narrows the content box, so the trigger
 * and its neighbours visibly shift the moment the overlay opens. `z-index`
 * cannot escape an overflow clip; only leaving the subtree can.
 *
 * Returns a style object for the floating element, or null while closed:
 * fixed coordinates derived from the anchor's viewport rect, flipped above the
 * anchor when there is not enough room below, clamped horizontally into the
 * viewport, and capped to the free space so the overlay scrolls internally
 * instead of pushing the page taller.
 */

const VIEWPORT_PADDING = 8;
// Below this much free space, opening downward is not worth it — flip instead.
const MIN_USABLE_SPACE = 120;

export function useAnchoredOverlay(anchorRef, isOpen, options = {}) {
  const {
    gap = 6,
    matchAnchorWidth = true,
    maxHeight = 240,
    minWidth = 0,
    // Explicit width wins over matchAnchorWidth; `align: 'end'` right-aligns the
    // overlay with the anchor (what a right-hand header popover wants).
    width: fixedWidth,
    align = 'start'
  } = options;
  const [style, setStyle] = useState(null);

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    // clientWidth/Height exclude scrollbars, which is the box a fixed element sits in.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const spaceBelow = vh - rect.bottom - gap - VIEWPORT_PADDING;
    const spaceAbove = rect.top - gap - VIEWPORT_PADDING;
    const flip = spaceBelow < Math.min(maxHeight, MIN_USABLE_SPACE) && spaceAbove > spaceBelow;

    const available = Math.max(MIN_USABLE_SPACE / 2, flip ? spaceAbove : spaceBelow);

    let width;
    if (fixedWidth !== undefined) {
      // Never wider than the viewport allows, however narrow the device.
      width = Math.min(fixedWidth, vw - VIEWPORT_PADDING * 2);
    } else if (matchAnchorWidth) {
      width = Math.max(rect.width, minWidth);
    }

    let left = align === 'end' && width !== undefined ? rect.right - width : rect.left;
    if (width !== undefined) {
      const rightBound = Math.max(VIEWPORT_PADDING, vw - width - VIEWPORT_PADDING);
      left = Math.min(Math.max(VIEWPORT_PADDING, left), rightBound);
    }

    setStyle({
      position: 'fixed',
      // Anchoring the flipped case by `bottom` keeps the overlay glued to the
      // trigger regardless of how few options it ends up rendering.
      top: flip ? undefined : rect.bottom + gap,
      bottom: flip ? vh - rect.top + gap : undefined,
      left,
      width,
      maxHeight: Math.min(maxHeight, available)
    });
  }, [anchorRef, gap, matchAnchorWidth, maxHeight, minWidth, fixedWidth, align]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setStyle(null);
      return undefined;
    }
    update();

    // Capture phase, so scrolling *any* ancestor scroller re-anchors the overlay,
    // not just the document. visualViewport covers pinch-zoom and mobile toolbars.
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, [isOpen, update]);

  return style;
}

export default useAnchoredOverlay;
