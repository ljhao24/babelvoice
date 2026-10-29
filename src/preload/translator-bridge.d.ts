import type { BabelVoiceBridge } from './index.js';

declare global {
  interface Window {
    babelVoiceBridge: BabelVoiceBridge;
  }
}

export {};
