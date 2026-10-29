import { describe, expect, it } from 'vitest';
import { isListenPlaybackActive } from './config-types.js';

describe('isListenPlaybackActive', () => {
  it('plays only when the user wants playback and a source app is tapped', () => {
    expect(
      isListenPlaybackActive({
        listenModePlayTts: true,
        listenSourceAppBundleId: 'us.zoom.xos'
      })
    ).toBe(true);
  });

  it('stays subtitles-only for a synced playback flag without a local source app', () => {
    expect(isListenPlaybackActive({ listenModePlayTts: true })).toBe(false);
    expect(
      isListenPlaybackActive({ listenModePlayTts: true, listenSourceAppBundleId: '' })
    ).toBe(false);
  });

  it('lets a source app be tapped without playback', () => {
    expect(
      isListenPlaybackActive({
        listenModePlayTts: false,
        listenSourceAppBundleId: 'us.zoom.xos'
      })
    ).toBe(false);
  });
});
