import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4173,
    proxy: {
      '/api': 'http://localhost:4001',
      // Only proxy file-watcher and vision WS — agent connects directly to port 4002
      '/ws/files': { target: 'ws://localhost:4001', ws: true },
      '/ws/vision': { target: 'ws://localhost:4001', ws: true },
    },
  },
});
