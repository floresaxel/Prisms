/**
 * Where a screen that loads on demand waits, and what shows if it cannot load.
 *
 * The wait is normally invisible: the screen the page opens on is fetched while
 * the app boots, and the others once the browser is idle (`screens.ts`). The
 * failure case is a stale page: a deploy replaced the hashed chunks while this
 * tab still runs the previous build, and the screen it asks for no longer
 * exists on the server. Reloading picks up the new build, so that is the one
 * thing offered — rather than the blank page a lazy component throws up to.
 */
import { Component, Suspense, type ReactNode } from 'react';

import { Skeleton } from '@prisms/ui';

interface State {
  failed: boolean;
}

export class ScreenBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="px-error" data-testid="screen-failed" role="alert">
          This screen could not be loaded — the app was probably updated in the meantime.{' '}
          <button className="px-btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return <Suspense fallback={<Skeleton rows={4} testId="screen-loading" />}>{this.props.children}</Suspense>;
  }
}
