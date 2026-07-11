import { useEffect, useRef } from 'react';

/**
 * Dismissal behaviour shared by every floating overlay in the app — the
 * notification popover, the CustomSelect menu, the FloatingBulkBar overflow menu,
 * and anything added later. Positioning lives in `useAnchoredOverlay`; this hook
 * owns *when the layer closes*:
 *
 *   1. Outside click — a pointer press anywhere that is not inside one of the
 *      passed `anchors` (the trigger and the portaled panel) closes the layer.
 *      The press is not otherwise interfered with, so the same click that closes
 *      the popover can still activate whatever was clicked (a nav item, a button).
 *   2. Escape closes the layer. It is handled in the capture phase and its
 *      propagation is stopped, so pressing Escape on an overlay opened inside a
 *      dialog dismisses only the overlay, never the dialog underneath it.
 *   3. Single open at a time — opening one layer dismisses any other that is still
 *      open, enforced through a module-level registry. This is what makes opening
 *      a dropdown (or any other overlay) close the notification popover, and vice
 *      versa, without every call site having to know about the others.
 *
 * `anchors` is an array of refs. A ref whose `.current` is null (e.g. a panel that
 * is portaled only while open) is simply skipped.
 */

// Every currently-open layer's close callback. At most one entry in practice,
// but a Set keeps add/remove trivial and tolerates re-entrancy.
const openLayers = new Set();

export function useDismissableLayer(isOpen, onClose, anchors = []) {
  // Kept in refs so the effect can depend on `isOpen` alone: neither a new inline
  // `onClose` nor a fresh `anchors` array on every render should tear the
  // listeners down and re-run the single-open eviction.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  useEffect(() => {
    if (!isOpen) return undefined;

    const close = () => { onCloseRef.current(); };

    // Opening this layer evicts any other that is still open.
    openLayers.forEach((other) => { if (other !== close) other(); });
    openLayers.add(close);

    const isInside = (target) =>
      anchorsRef.current.some((ref) => ref && ref.current && ref.current.contains(target));

    const onPointerDown = (event) => {
      if (!isInside(event.target)) close();
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      openLayers.delete(close);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen]);
}

export default useDismissableLayer;
