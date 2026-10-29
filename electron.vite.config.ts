import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: {
          control: resolve('src/renderer/index.html'),
          subtitle: resolve('src/renderer/subtitle.html')
        }
      }
    }
  }
});
