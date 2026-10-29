import { useEffect } from 'react';
import { useAppStore } from '../store/app-store.js';

/**
 * Keeps the store's `subtitleOverlayVisible` in sync with main (session
 * auto-show, the overlay's own close button, the toggle below). Mounted
 * once at the control-panel root (see `useRendererWiring`).
 */
export function useSubtitleOverlayVisibleWiring(): void {
  const apply = useAppStore((s) => s.applySubtitleOverlayVisible);

  useEffect(() => {
    let alive = true;
    void window.babelVoiceBridge.getSubtitleOverlayVisible().then((v) => {
      if (alive) apply(v);
    });
    const unsub = window.babelVoiceBridge.onSubtitleOverlayVisibility(apply);
    return () => {
      alive = false;
      unsub();
    };
  }, [apply]);
}

const toggleSubtitleOverlay = async (): Promise<void> => {
  useAppStore
    .getState()
    .applySubtitleOverlayVisible(await window.babelVoiceBridge.toggleSubtitleOverlay());
};

/**
 * Whether the subtitle overlay window is showing, plus a toggle for
 * reopening it after the user closed it.
 */
export const useSubtitleOverlayVisible = (): {
  visible: boolean;
  toggle: () => Promise<void>;
} => {
  const visible = useAppStore((s) => s.subtitleOverlayVisible);
  return { visible, toggle: toggleSubtitleOverlay };
};
