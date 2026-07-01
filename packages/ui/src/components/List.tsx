/** A simple vertical list with optional leading/trailing slots per row. */
import type { ReactNode } from 'react';

export interface ListProps {
  children: ReactNode;
  empty?: ReactNode;
  /**
   * §7.15 (M12, Fix C): the backing read has not hydrated yet. When the list is
   * empty AND still loading, show a skeleton instead of the `empty` state — so a
   * fresh login / cold read never flashes "nothing here" before the rows arrive.
   * Screens pass `loading={!isHydrated}` from the loading-aware read layer.
   */
  loading?: boolean;
  /** Skeleton row count while loading (default 3). */
  skeletonRows?: number;
}

export function List({ children, empty, loading = false, skeletonRows = 3 }: ListProps) {
  const isEmpty = Array.isArray(children) && children.length === 0;
  if (isEmpty) {
    return (
      <ul className="px-list" aria-busy={loading || undefined}>
        {loading ? <ListSkeleton rows={skeletonRows} /> : <li className="px-list-empty">{empty ?? 'Nothing here'}</li>}
      </ul>
    );
  }
  return <ul className="px-list">{children}</ul>;
}

export interface ListItemProps {
  children: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}

export function ListItem({ children, leading, trailing, onClick }: ListItemProps) {
  return (
    <li className="px-list-item" onClick={onClick} role={onClick ? 'button' : undefined}>
      {leading != null && <span className="px-list-leading">{leading}</span>}
      <span className="px-list-body">{children}</span>
      {trailing != null && <span className="px-list-trailing">{trailing}</span>}
    </li>
  );
}

export interface SkeletonProps {
  /** Number of shimmer lines (default 3). */
  rows?: number;
  testId?: string;
}

/**
 * §7.15 skeleton block for non-`List` empty branches (a section, a chart area, a
 * hand-rolled `<ul>`). Purely decorative — `aria-hidden` + `aria-busy` so screen
 * readers announce "busy" rather than reading placeholder bars.
 */
export function Skeleton({ rows = 3, testId = 'skeleton' }: SkeletonProps) {
  return (
    <div className="px-skeleton-block" data-testid={testId} aria-busy="true" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="px-skeleton px-skeleton-line" />
      ))}
    </div>
  );
}

/** §7.15 skeleton rows shaped as `px-list-item`s — for use inside a `<ul className="px-list">`. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-list-item px-skeleton-item" data-testid="list-skeleton" aria-hidden="true">
          <span className="px-skeleton px-skeleton-line" />
        </li>
      ))}
    </>
  );
}
