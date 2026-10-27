import { defineConfig } from 'vite';

/**
 * Editor build configuration.
 * `root` points at editor/, the output goes to dist/editor and can be served by Nginx
 * directly (relative `base`).
 */
export default defineConfig({
  root: 'editor',
  base: './',
  publicDir: false,
  server: {
    port: 5173,
    strictPort: false,
    open: false,
    fs: {
      // Allow reading samples/ from the repo root (shared by the editor and the WPF demo)
      allow: ['..'],
    },
  },
  build: {
    outDir: '../dist/editor',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
