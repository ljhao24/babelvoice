import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Plain Vite config for browser-only frontend debugging.
 *
 * Use:
 *   npm run dev:web
 *
 * Then open http://localhost:5180/. The renderer will load with a stubbed
 * `window.babelVoiceBridge` (see `src/renderer/dev/web-shim.ts`) so the UI
 * can render without an Electron host. Real translation, audio, and IPC
 * features are no-ops — this is purely for visual / layout iteration.
 */

const projectRoot = process.cwd();

const injectWebShim = {
  name: 'babelvoice-inject-web-shim',
  // Both entries (control panel and subtitle overlay) need the stub bridge.
  transformIndexHtml(html) {
    return html.replace(
      /<script type="module" src="\.\/(main|subtitle)\.tsx"><\/script>/,
      (entry) => ['<script type="module" src="./dev/web-shim.ts"></script>', entry].join('\n    ')
    );
  }
};

export default defineConfig({
  root: resolve(projectRoot, 'src/renderer'),
  plugins: [react(), injectWebShim],
  resolve: {
    alias: {
      '@core': resolve(projectRoot, 'src/core'),
      '@shared': resolve(projectRoot, 'src/shared'),
      '@': resolve(projectRoot, 'src/renderer')
    }
  },
  server: {
    port: 5180,
    strictPort: false,
    open: true
  }
});
