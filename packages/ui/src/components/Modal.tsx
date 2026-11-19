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
   * viewport and blurs what is behind it harder — for a dialog that is a task in
   * its own right rather than a confirmation. `'card'` sits between them: a wider
   * centered card, for a form that edits something already on screen; it scrolls
   * inside itself when it is taller than the window. Every size blurs the page
   * behind it — none of them darkens it.
   */
  size?: 'panel' | 'card' | 'full';
  /** Optional lead-in under the title, inside the full-screen header. */
  subtitle?: ReactNode;
  /**
   * The dialog's accessible name when it draws its own header instead of
   * `title` (an editable heading, say). Ignored when `title` is set.
   */
  label?: string;
  /** Extra class on the dialog box, for a dialog with its own layout. */
  className?: string;
}

export function Modal({ open, title, onClose, children, actions, size = 'panel', subtitle, label, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A full-screen or card dialog owns the viewport: stop the page behind it scrolling.
  useEffect(() => {
    if (!open || size === 'panel') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, size]);

  if (!open) return null;
  const full = size === 'full';
  const scrim = full ? ' px-scrim--blur' : size === 'card' ? ' px-scrim--soft' : '';
  return (
    <div className={`px-scrim${scrim}`} onClick={onClose} role="presentation">
      <div
        className={`px-modal${full ? ' px-modal--full' : size === 'card' ? ' px-modal--card' : ''}${className ? ` ${className}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? label}
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
