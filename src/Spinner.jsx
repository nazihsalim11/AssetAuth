import React from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * The single loading glyph for the whole app: a rotating RefreshCw.
 *
 * Every in-flight action — button spinners, inline "refreshing" hints — renders
 * this so the loading language is identical everywhere. The `.animate-spin` class
 * (index.css) drives the rotation and already honours prefers-reduced-motion.
 */
export const Spinner = ({ size = 14, className = '', ...rest }) => (
  <RefreshCw size={size} className={`animate-spin ${className}`.trim()} aria-hidden="true" {...rest} />
);

export default Spinner;
