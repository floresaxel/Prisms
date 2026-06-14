/** A simple vertical list with optional leading/trailing slots per row. */
import type { ReactNode } from 'react';

export interface ListProps {
  children: ReactNode;
  empty?: ReactNode;
}

export function List({ children, empty }: ListProps) {
  const isEmpty = Array.isArray(children) && children.length === 0;
  return <ul className="px-list">{isEmpty ? <li className="px-list-empty">{empty ?? 'Nothing here'}</li> : children}</ul>;
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
