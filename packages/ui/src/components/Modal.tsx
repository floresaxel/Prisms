/** A centered modal over a scrim; closes on scrim click or Escape. */
import { useEffect, useRef, useState, type ReactNode } from 'react';

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

/** How long the exit plays: matches `px-scrim-out` / `px-modal-out` in theme.css. */
export const MODAL_EXIT_MS = 180;

/**
 * Close at once, with no exit: when the user asks for less motion, and where
 * there is no `matchMedia` to ask (jsdom) — the exit is purely cosmetic.
 */
function skipExit(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The open modals, oldest first — the last one owns Escape. */
const openModals: symbol[] = [];

export function Modal(props: ModalProps) {
  const { open, onClose } = props;

  // On close the dialog stays mounted for MODAL_EXIT_MS while it blurs out and the
  // page behind comes back into focus. It plays the LAST props it had while open:
  // a parent usually clears the data the dialog shows in the same update that
  // closes it, and the card must not go blank on its way out.
  const last = useRef(props);
  if (open) last.current = props;
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (skipExit()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), MODAL_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  // Escape belongs to the topmost open modal only: a dialog opened over another
  // (a session review over the task card) must not close the one behind it too.
  // (`onClose` rides a ref so a new callback each render doesn't re-push this modal on top.)
  const token = useRef<symbol>(Symbol('modal'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = token.current;
    openModals.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openModals[openModals.length - 1] === me) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openModals.indexOf(me);
      if (i >= 0) openModals.splice(i, 1);
    };
  }, [open]);

  const size = last.current.size ?? 'panel';
  // A full-screen or card dialog owns the viewport: stop the page behind it scrolling.
  useEffect(() => {
    if (!open || size === 'panel') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, size]);

  if (!open && (!mounted || skipExit())) return null;
  const closing = !open;
  const { title, children, actions, subtitle, label, className } = last.current;
  const full = size === 'full';
  const scrim = full ? ' px-scrim--blur' : size === 'card' ? ' px-scrim--soft' : '';
  return (
    <div
      className={`px-scrim${scrim}${closing ? ' px-scrim--out' : ''}`}
      onClick={closing ? undefined : onClose}
      role="presentation"
      // on its way out it is a picture of the dialog: nothing in it can be reached
      inert={closing}
      data-state={closing ? 'closing' : 'open'}
    >
      <div
        className={`px-modal${full ? ' px-modal--full' : size === 'card' ? ' px-modal--card' : ''}${className ? ` ${className}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal={closing ? undefined : true}
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
