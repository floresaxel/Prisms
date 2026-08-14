/**
 * Cross-fades the day's note when you move between days.
 *
 * The note panel is keyed by date, so a day change unmounts one and mounts
 * another — the outgoing note vanished on the very frame the incoming one
 * appeared, which read as a flash rather than a change. This keeps the outgoing
 * panel on screen for the length of its fade, layered OVER the incoming one, so
 * the two overlap and neither has to wait for the other.
 */
import { useEffect, useState, type ReactNode } from 'react';

/** How long the leaving note takes to go. Matches `px-note-out` in theme.css. */
const FADE_OUT_MS = 100;

interface Layer {
  key: string;
  node: ReactNode;
}

export function NoteSwap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  /**
   * The element rendered for the CURRENT key, captured at the moment the key last
   * changed. Kept so the outgoing layer has something to draw; a day's panel takes
   * only stable props (its date), so a snapshot cannot go stale in a way that
   * shows.
   */
  const [snap, setSnap] = useState<Layer>({ key: swapKey, node: children });
  const [leaving, setLeaving] = useState<Layer | null>(null);

  if (snap.key !== swapKey) {
    // React's sanctioned "adjust state when a prop changes": both setters are
    // behind the comparison, so this settles in one extra render rather than
    // looping.
    setLeaving(snap);
    setSnap({ key: swapKey, node: children });
  }

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), FADE_OUT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  // Going BACK to the day that is still fading out would put two layers under one
  // key. Drop the ghost instead — the day being returned to is the live one.
  const ghost = leaving && leaving.key !== swapKey ? leaving : null;

  /**
   * Keyed layers, not positions. React matches children by key, so when the
   * outgoing layer changes places in this list it is MOVED rather than rebuilt —
   * which matters: rebuilding would remount a whole editor (and its save
   * machinery) purely to fade it out.
   */
  const layers: Layer[] = ghost ? [ghost, { key: swapKey, node: children }] : [{ key: swapKey, node: children }];

  return (
    <div className="px-note-swap">
      {layers.map((l) => {
        const isGhost = ghost !== null && l.key === ghost.key;
        return (
          <div
            key={l.key}
            className={`px-note-layer${isGhost ? ' px-note-layer--out' : ''}`}
            aria-hidden={isGhost || undefined}
          >
            {l.node}
          </div>
        );
      })}
    </div>
  );
}
