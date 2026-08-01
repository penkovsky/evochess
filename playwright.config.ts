import { defineConfig, devices } from "@playwright/test";

// The app is served under Vite's base path — keep in sync with `base` in
// vite.config.ts, or every navigation 404s.
const BASE_PATH = "/evochess/";
const PORT = 5173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: `http://localhost:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // The daily-puzzle spec stubs this host with `page.route`, but the request
    // is only made at all when both values are set (dailyPuzzle.ts, telemetry.ts)
    // — so the build needs them, and it must be somewhere nothing real listens.
    // With `reuseExistingServer`, a dev server started by hand without these
    // will make that spec fail; stop it and let Playwright start its own.
    env: {
      VITE_TELEMETRY_URL: "http://127.0.0.1:59999",
      VITE_TELEMETRY_KEY: "e2e-stub-key",
    },
  },
});
