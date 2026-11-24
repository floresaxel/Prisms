/**
 * Focus an element once the NEXT render has committed — for "pick a project, then
 * Enter" flows. The button that should take focus is often disabled until the
 * choice re-renders it, and the picker hands focus back to its own trigger in the
 * same click; focusing from an effect after that render lands on the right
 * element, enabled. Each call asks again, so picking the same thing twice still
 * moves focus.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

export function useFocusAfterRender(): (target: RefObject<HTMLElement | null>) => void {
  const [ask, setAsk] = useState<{ target: RefObject<HTMLElement | null> } | null>(null);
  useEffect(() => {
    if (!ask) return;
    setAsk(null);
    ask.target.current?.focus();
  }, [ask]);
  return useCallback((target) => setAsk({ target }), []);
}
