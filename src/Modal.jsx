import React, { useEffect, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { lockBodyScroll, unlockBodyScroll } from './scrollLock';

/**
 * The single modal layout every dialog in the app uses.
 *
 *   Modal
 *   ├── header  (fixed)
 *   ├── body    (the only scrolling region)
 *   └── footer  (fixed)
 *
 * Why this exists: dialogs used to be hand-rolled, and nine of them wrapped the body
 * and footer in a bare <form>. `.modal-content` is a flex column capped at the
 * viewport height, but that <form> was an unstyled flex item with the default
 * `min-height: auto`, so it could not shrink below its content. The body's
 * `overflow-y: auto` never engaged, the form grew past the cap, and the footer ended
 * up rendered outside the visible dialog. Passing `as="form"` here makes the form
 * *be* `.modal-content`, so the flex chain is never broken.
 *
 * Everything else is handled once, for every dialog:
 *   - Rendered through a portal, so a dialog can never be trapped inside a
 *     transformed/overflow-hidden ancestor, and nesting a modal inside a form modal
 *     does not produce invalid nested <form> markup.
 *   - Background scroll is locked while any modal is open (reference counted, so
 *     closing a stacked modal does not unlock the page early).
 *   - Escape closes only the topmost modal.
 *   - Focus moves into the dialog and is restored to the trigger on close.
 */

/* --------------------------- escape handling for the topmost modal --------------------------- */

const modalStack = [];

const SIZES = {
  sm: '440px',
  md: '560px',
  lg: '680px',
  xl: '820px',
  full: '1100px'
};

const Modal = ({
  isOpen = true,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'lg',
  maxWidth,
  as = 'div',
  onSubmit,
  zIndex,
  // Opt-in, not opt-out. Only three dialogs dismissed on a backdrop click before this
  // refactor; defaulting to true would let a stray click discard a half-filled form.
  closeOnOverlayClick = false,
  closeOnEscape = true,
  showCloseButton = true,
  closeDisabled = false,
  contentStyle = {},
  bodyStyle = {},
  ariaLabel
}) => {
  const contentRef = useRef(null);
  const previouslyFocused = useRef(null);
  const instanceId = useRef({});
  // Unique per instance: two stacked dialogs must not both own `id="modal-title"`,
  // or aria-labelledby resolves to whichever happens to be first in the document.
  const titleId = useId();

  const close = useCallback(() => {
    if (typeof onClose === 'function') onClose();
  }, [onClose]);

  // Scroll lock + focus management, for as long as this modal is mounted and open.
  useEffect(() => {
    if (!isOpen) return undefined;

    const token = instanceId.current;
    previouslyFocused.current = document.activeElement;
    lockBodyScroll();
    modalStack.push(token);

    // Move focus into the dialog so keyboard users are not left behind the overlay.
    const focusTimer = window.setTimeout(() => {
      const node = contentRef.current;
      if (!node) return;
      const focusable = node.querySelector(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      (focusable || node).focus({ preventScroll: true });
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      const index = modalStack.indexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      unlockBodyScroll();
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // Only the topmost modal reacts to Escape, so a stacked dialog does not close both.
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (modalStack[modalStack.length - 1] !== instanceId.current) return;
      e.stopPropagation();
      close();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, closeOnEscape, close]);

  if (!isOpen) return null;

  const Tag = as === 'form' ? 'form' : 'div';
  const tagProps = Tag === 'form' ? { onSubmit, noValidate: false } : {};

  const overlay = (
    <div
      className="modal-overlay"
      style={zIndex ? { zIndex } : undefined}
      // Only a click that both starts and ends on the overlay dismisses. A drag that
      // begins inside the dialog (selecting text) must not close it.
      onMouseDown={(e) => {
        if (closeOnOverlayClick && !closeDisabled && e.target === e.currentTarget) close();
      }}
    >
      <Tag
        {...tagProps}
        ref={contentRef}
        className="modal-content"
        style={{ ...(maxWidth ? { maxWidth } : { maxWidth: SIZES[size] || SIZES.lg }), ...contentStyle }}
        role="dialog"
        aria-modal="true"
        aria-label={!title ? ariaLabel : undefined}
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || showCloseButton) && (
          <div className="modal-header">
            <div style={{ minWidth: 0 }}>
              {title && <h3 className="modal-title" id={titleId}>{title}</h3>}
              {subtitle && (
                <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{subtitle}</span>
              )}
            </div>
            {showCloseButton && onClose && (
              <button
                type="button"
                className="modal-close-btn"
                onClick={close}
                disabled={closeDisabled}
                aria-label="Close dialog"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}

        <div className="modal-body" style={bodyStyle}>
          {children}
        </div>

        {footer && <div className="modal-footer">{footer}</div>}
      </Tag>
    </div>
  );

  // Portal to <body>: keeps the dialog out of any transformed or clipped ancestor,
  // and avoids nesting a <form> modal inside another <form>.
  return createPortal(overlay, document.body);
};

export default Modal;
