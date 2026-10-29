import type { BabelVoiceBridge } from '../preload/index.js';

declare global {
  interface Window {
    babelVoiceBridge: BabelVoiceBridge;
  }

  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
