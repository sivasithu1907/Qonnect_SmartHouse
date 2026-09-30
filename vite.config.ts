import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In development the API runs separately (npm run dev:api) on port 8080.
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8080', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
