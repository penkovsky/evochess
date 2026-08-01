import type { Page } from "@playwright/test";

/** Keep in sync with src/evochess/tutorialProgress.ts. */
const TUTORIAL_KEY = "evochess-tutorial-v1";

/**
 * Playwright gives every test a fresh browser context, so localStorage starts
 * empty — which the app reads as a first-time visitor and answers with the
 * tutorial instead of the board (App.tsx). Specs about the *game* therefore
 * have to opt out of it explicitly.
 *
 * The flag is set via an init script rather than after loading, so it is in
 * place before the app's first read of it.
 */
export async function freshGamePage(page: Page) {
  await page.addInitScript(
    ([key]) => {
      window.localStorage.setItem(key, JSON.stringify({ completed: [], seen: true }));
    },
    [TUTORIAL_KEY]
  );
  await page.goto("./");
}

/**
 * A genuine first visit: no init script at all, so nothing rewrites storage on
 * later navigations and a reload can be used to check what the app persisted.
 */
export async function firstVisitPage(page: Page) {
  await page.goto("./");
}

/** The collector the e2e build points at — keep in sync with `playwright.config.ts`. */
export const COLLECTOR_URL = "http://127.0.0.1:59999";

/**
 * Answers every collector request with a 201, so nothing is actually sent.
 *
 * Nothing listens on that host, and Chromium reports a refused connection as a
 * console error — which a spec asserting on console output would otherwise
 * count as the app's. Only such specs need this; everywhere else the failure is
 * swallowed by telemetry.ts and the row simply stays queued.
 */
export async function silenceCollector(page: Page) {
  await page.route(`${COLLECTOR_URL}/**`, (route) => route.fulfill({ status: 201, body: "" }));
}
