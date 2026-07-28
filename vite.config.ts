/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/evochess/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Unit tests under src/ and the data-pipeline tests under training/;
    // Playwright owns e2e/. training/ was omitted originally, which quietly
    // meant `npm test` never ran augment.test.ts or sampler.test.ts at all.
    // (training/tests/ is the Python side, run by pytest, and matches nothing
    // here.)
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'training/**/*.{test,spec}.ts'],
  },
})
