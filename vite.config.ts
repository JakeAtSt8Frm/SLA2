import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: Number(process.env.PORT ?? 5180),
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
