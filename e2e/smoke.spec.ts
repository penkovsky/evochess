import { test, expect } from "@playwright/test";
import { freshGamePage } from "./helpers";

test.beforeEach(async ({ page }) => {
  // Start from a clean slate so a persisted game doesn't leak between runs.
  await freshGamePage(page);
});

test("renders the board and per-color evolution counters", async ({ page }) => {
  // The chessboard mounts.
  await expect(page.locator("[data-column]").first()).toBeVisible();

  // One evolution strip per side, flanking the board rather than in the panel.
  await expect(page.locator(".board-wrap .evo-strip")).toHaveCount(2);
  // Each strip carries a minor-rights and a rook-rights dot group.
  await expect(page.locator(".evo-strip .evo-dots")).toHaveCount(4);

  await page.screenshot({ path: "e2e/__screenshots__/counters.png", fullPage: true });
});
