import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { useAnchoredOverlay } from './useAnchoredOverlay';
import { useDismissableLayer } from './useDismissableLayer';

// Reusable Custom Premium Dropdown Component
const CustomSelect = ({
  options = [],
  value,
  onChange,
  placeholder = 'Select option...',
  disabled = false,
  className = '',
  style = {},
  id = '',
  name = '',
  required = false,
  searchable = false,
  searchPlaceholder = 'Type to filter...'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = React.useRef(null);
  const listRef = React.useRef(null);
  const triggerRef = React.useRef(null);

  const menuStyle = useAnchoredOverlay(triggerRef, isOpen);

  const normalizedOptions = options.map(opt => {
    if (typeof opt === 'object' && opt !== null) {
      return { value: opt.value, label: opt.label || opt.value };
    }
    return { value: opt, label: opt };
  });

  const selectedOption = normalizedOptions.find(opt => String(opt.value) === String(value));

  // With `searchable`, the rendered list is filtered but `normalizedOptions` is not,
  // so the selected label still resolves even when it is filtered out of view.
  const visibleOptions = searchable && searchTerm.trim()
    ? normalizedOptions.filter(opt => String(opt.label).toLowerCase().includes(searchTerm.trim().toLowerCase()))
    : normalizedOptions;

  const toggleDropdown = () => {
    if (disabled) return;
    setIsOpen(prev => {
      if (prev) setSearchTerm('');
      return !prev;
    });
  };

  // Outside-click / Escape dismissal, plus the single-open registry shared with
  // every other overlay in the app. The menu is portaled to <body>, so listRef is
  // passed alongside the container: without it a press on an option would count as
  // "outside" and close the menu before the option's click handler ran.
  const closeSelect = React.useCallback(() => setIsOpen(false), []);
  useDismissableLayer(isOpen, closeSelect, [containerRef, listRef]);

  const handleKeyDown = (e) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else if (focusedIndex >= 0 && focusedIndex < visibleOptions.length) {
        selectOption(visibleOptions[focusedIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setFocusedIndex(0);
      } else {
        const nextIndex = visibleOptions.length ? (focusedIndex + 1) % visibleOptions.length : -1;
        setFocusedIndex(nextIndex);
        scrollIntoView(nextIndex);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setFocusedIndex(visibleOptions.length - 1);
      } else {
        const prevIndex = visibleOptions.length ? (focusedIndex - 1 + visibleOptions.length) % visibleOptions.length : -1;
        setFocusedIndex(prevIndex);
        scrollIntoView(prevIndex);
      }
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const selectOption = (opt) => {
    onChange({ target: { value: opt.value, name } });
    setIsOpen(false);
  };

  const scrollIntoView = (index) => {
    if (listRef.current) {
      // The search box occupies the first <li> when searchable, so option N is child N+1.
      const activeEl = listRef.current.children[searchable ? index + 1 : index];
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  React.useEffect(() => {
    if (isOpen) {
      const initialIndex = visibleOptions.findIndex(opt => String(opt.value) === String(value));
      setFocusedIndex(initialIndex >= 0 ? initialIndex : 0);
    } else {
      setFocusedIndex(-1);
    }
  }, [isOpen, value]);

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
      style={{ position: 'relative', width: '100%', ...style }}
      id={id}
    >
      <button
        type="button"
        ref={triggerRef}
        className="custom-select-trigger"
        onClick={toggleDropdown}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="custom-select-value">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown className="custom-select-chevron" size={16} />
      </button>

      {isOpen && createPortal(
        <ul
          ref={listRef}
          className="custom-select-menu"
          role="listbox"
          tabIndex={-1}
          // Hidden for the single render before useLayoutEffect measures the
          // anchor, so the menu never paints at an unpositioned location.
          style={menuStyle || { position: 'fixed', visibility: 'hidden' }}
        >
          {searchable && (
            <li style={{ padding: '4px', position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 1 }}>
              <input
                className="form-input"
                style={{ minHeight: '32px', fontSize: '12.5px' }}
                placeholder={searchPlaceholder}
                value={searchTerm}
                autoFocus
                onChange={(e) => { setSearchTerm(e.target.value); setFocusedIndex(-1); }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </li>
          )}
          {visibleOptions.length === 0 ? (
            <li className="custom-select-item is-disabled" style={{ fontStyle: 'italic', justifyContent: 'center' }}>
              {searchTerm ? 'No matches' : 'No options available'}
            </li>
          ) : (
            visibleOptions.map((opt, index) => {
              const isSelected = String(opt.value) === String(value);
              const isFocused = index === focusedIndex;
              return (
                <li
                  key={opt.value}
                  className={`custom-select-item ${isSelected ? 'is-selected' : ''} ${isFocused ? 'is-focused' : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectOption(opt)}
                  onMouseEnter={() => setFocusedIndex(index)}
                >
                  <span className="custom-select-item-label">{opt.label}</span>
                  {isSelected && <Check className="custom-select-item-check" size={14} />}
                </li>
              );
            })
          )}
        </ul>,
        document.body
      )}

      {(name || required) && (
        <input
          type="text"
          name={name}
          value={value || ''}
          required={required}
          readOnly
          style={{
            position: 'absolute',
            opacity: 0,
            pointerEvents: 'none',
            bottom: 0,
            left: 0,
            right: 0,
            height: '1px'
          }}
        />
      )}
    </div>
  );
};

export default CustomSelect;
