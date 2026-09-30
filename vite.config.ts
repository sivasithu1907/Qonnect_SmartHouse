import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Stamps a build-specific version into dist/sw.js so every deployment installs a new
 * service worker (which then replaces the cached app shell). The version is a hash of the
 * built index.html, so it only changes when the app actually changes.
 */
function stampServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'qonnect-stamp-sw',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const sw = path.resolve(outDir, 'sw.js');
      const html = path.resolve(outDir, 'index.html');
      if (!fs.existsSync(sw) || !fs.existsSync(html)) return;
      const version = crypto.createHash('sha256').update(fs.readFileSync(html)).update(fs.readFileSync(sw)).digest('hex').slice(0, 12);
      fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace('__SW_VERSION__', version));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  server: {
    // In development the API runs separately (npm run dev:api) on port 8080.
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8080', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
