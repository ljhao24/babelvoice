/**
 * Coordinates the "subtitle overlay renderer is mounted and listening"
 * handshake. The subtitle BrowserWindow may be opened (and the renderer
 * load+mount asynchronously) before a translation session wants to push
 * subtitle events to it; opening events arrive too early get dropped.
 *
 * The renderer signals readiness via IPC.SubtitleReady → markReady().
 * DirectionSession.open() blocks on awaitReady() before starting the
 * Doubao client. window-manager is the only writer of `reset` / `abandon`
 * (called from create / close handlers).
 *
 * Exposes a singleton because there is exactly one subtitle window in the
 * app, but the class itself is constructable for unit tests.
 */
const DEFAULT_AWAIT_TIMEOUT_MS = 5000;

interface Waiter {
  windowId: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SubtitleOverlayCoordinator {
  private readyWindowId: number | null = null;
  private readonly waiters: Waiter[] = [];

  /**
   * Reset readiness state — call when a fresh subtitle window has been
   * created but its renderer has not yet signalled ready.
   */
  reset(): void {
    this.readyWindowId = null;
  }

  /** True if the given window has signalled ready since the last reset. */
  isReady(windowId: number): boolean {
    return this.readyWindowId === windowId;
  }

  /**
   * Mark the window as ready and release any pending waiters whose
   * windowId matches. Waiters keyed to a different (presumably earlier
   * and now-closed) window are left intact for `abandon()` to reject.
   */
  markReady(windowId: number): void {
    this.readyWindowId = windowId;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.windowId !== windowId) continue;
      this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  /**
   * Wait for the given window to signal ready, or reject after timeoutMs.
   * Resolves immediately if the window is already ready.
   */
  awaitReady(
    windowId: number,
    timeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS
  ): Promise<void> {
    if (this.isReady(windowId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        windowId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error('Timed out waiting for subtitle overlay renderer'));
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Reject all pending waiters — call when the subtitle window closes
   * before any of them got their ready signal.
   */
  abandon(): void {
    this.readyWindowId = null;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error('Subtitle overlay closed before it became ready')
      );
    }
  }
}

export const subtitleOverlayCoordinator = new SubtitleOverlayCoordinator();
