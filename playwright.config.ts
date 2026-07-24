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
  },
});
