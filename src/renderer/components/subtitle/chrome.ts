import type { CSSProperties } from 'react';
import type { SubtitleBackground } from '@shared/config-types.js';

/** Panel chrome class for a subtitle background (overlay and settings preview). */
export function chromeClassFor(bg: SubtitleBackground): string {
  // Not `.glass`: its backdrop-filter has nothing to blur in this
  // transparent, non-vibrant window and only adds compositing cost.
  if (bg === 'glass') return 'overlay-glass';
  if (bg === 'solid') return 'border border-white/10';
  return 'subtitle-bare';
}

export function chromeStyleFor(bg: SubtitleBackground, opacityPct: number): CSSProperties {
  const a = Math.max(0, Math.min(100, opacityPct)) / 100;
  if (bg === 'glass') {
    return { background: `rgb(var(--bg-elev) / ${a})` };
  }
  if (bg === 'solid') {
    return { background: `rgb(var(--bg) / ${a})` };
  }
  return { background: 'transparent' };
}
