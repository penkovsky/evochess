import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Start from a clean slate so a persisted game doesn't leak between runs.
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("./");
});

test("renders the board and per-color evolution counters", async ({ page }) => {
  // The chessboard mounts.
  await expect(page.locator("[data-column]").first()).toBeVisible();

  // Both evolution tracks are shown for each side.
  await expect(page.getByText("Pawns → Minor")).toHaveCount(2);
  await expect(page.getByText("Minors → Rook")).toHaveCount(2);

  await page.screenshot({ path: "e2e/__screenshots__/counters.png", fullPage: true });
});
