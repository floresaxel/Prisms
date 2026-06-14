/** A centered modal over a scrim; closes on scrim click or Escape. */
import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

export function Modal({ open, title, onClose, children, actions }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="px-scrim" onClick={onClose} role="presentation">
      <div className="px-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        {title != null && <h2 className="px-modal-title">{title}</h2>}
        <div className="px-modal-body">{children}</div>
        {actions != null && <div className="px-modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
