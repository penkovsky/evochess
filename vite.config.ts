/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/evochess/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(gitSha()),
  },
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
