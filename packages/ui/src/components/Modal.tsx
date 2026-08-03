/** A centered modal over a scrim; closes on scrim click or Escape. */
import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  /**
   * `'panel'` (default) is the compact centered card. `'full'` covers the
   * viewport and blurs what is behind it — for a dialog that is a task in its
   * own right rather than a confirmation.
   */
  size?: 'panel' | 'full';
  /** Optional lead-in under the title, inside the full-screen header. */
  subtitle?: ReactNode;
}

export function Modal({ open, title, onClose, children, actions, size = 'panel', subtitle }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A full-screen dialog owns the viewport: stop the page behind it scrolling.
  useEffect(() => {
    if (!open || size !== 'full') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, size]);

  if (!open) return null;
  const full = size === 'full';
  return (
    <div className={`px-scrim${full ? ' px-scrim--blur' : ''}`} onClick={onClose} role="presentation">
      <div
        className={`px-modal${full ? ' px-modal--full' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={full ? 'px-modal-inner' : undefined}>
          {title != null && <h2 className="px-modal-title">{title}</h2>}
          {subtitle != null && <p className="px-modal-sub">{subtitle}</p>}
          <div className="px-modal-body">{children}</div>
          {actions != null && <div className="px-modal-actions">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
