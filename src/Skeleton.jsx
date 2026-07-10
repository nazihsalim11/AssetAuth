import React from 'react';

/**
 * Loading placeholders, shaped like the content they stand in for.
 *
 * The point is not decoration: a counter that renders `0` while its fetch is in
 * flight is indistinguishable from a counter that genuinely means zero, and the
 * user believes the wrong thing for as long as the request takes. A skeleton says
 * "not yet" — an empty table says "there is nothing".
 *
 * The `.skeleton*` classes and the shimmer already exist in index.css.
 */

export const Skeleton = ({ className = '', style, width, height, ...rest }) => (
  <span
    className={`skeleton ${className}`.trim()}
    style={{ display: 'block', width, height, ...style }}
    aria-hidden="true"
    {...rest}
  />
);

/** Stands in for a number in a stat card — never render a placeholder 0. */
export const SkeletonValue = ({ width = '3.5ch' }) => (
  <Skeleton style={{ width, height: '1.6em', marginTop: '2px' }} />
);

export const SkeletonText = ({ lines = 3 }) => (
  <div aria-hidden="true">
    {Array.from({ length: lines }, (_, i) => (
      <span key={i} className="skeleton skeleton-text" style={{ display: 'block' }} />
    ))}
  </div>
);

export const SkeletonCards = ({ count = 4 }) => (
  <div className="stat-strip" aria-hidden="true">
    {Array.from({ length: count }, (_, i) => (
      <span key={i} className="skeleton skeleton-card" style={{ display: 'block' }} />
    ))}
  </div>
);

/** A table's worth of rows. Matches .table-container's own padding. */
export const SkeletonTable = ({ rows = 6 }) => (
  <div className="table-container" style={{ padding: 'var(--sp-4)' }} aria-hidden="true">
    <span className="skeleton skeleton-title" style={{ display: 'block' }} />
    {Array.from({ length: rows }, (_, i) => (
      <span key={i} className="skeleton skeleton-row" style={{ display: 'block' }} />
    ))}
  </div>
);

/** The default whole-page placeholder: a header, a strip of cards, a table. */
export const PageSkeleton = ({ cards = 4, rows = 6 }) => (
  <div
    // Announced once, rather than letting a screen reader read a wall of empty boxes.
    role="status"
    aria-busy="true"
    aria-live="polite"
    aria-label="Loading data"
    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)', width: '100%' }}
  >
    <div>
      <span className="skeleton skeleton-title" style={{ display: 'block', width: '30%' }} />
      <span className="skeleton skeleton-text" style={{ display: 'block', width: '55%' }} />
    </div>
    {cards > 0 && <SkeletonCards count={cards} />}
    {rows > 0 && <SkeletonTable rows={rows} />}
  </div>
);

export default Skeleton;
