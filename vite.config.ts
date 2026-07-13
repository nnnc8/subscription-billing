import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
  },
  server: {
    proxy: {
      // Forward all /api requests to Express backend (keeps cookies same-origin)
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
        secure: false,
      }
    }
  }
})
