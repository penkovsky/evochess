/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/evochess-web/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Keep Vitest to unit tests under src/; Playwright owns e2e/.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
