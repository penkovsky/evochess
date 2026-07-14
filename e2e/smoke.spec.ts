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

test("shows the flip-board toggle only in human-vs-human mode", async ({ page }) => {
  const toggle = page.getByLabel("Flip board each turn");

  // Hidden by default (Human vs AI).
  await expect(toggle).toHaveCount(0);

  await page.getByRole("combobox").first().selectOption("human-human");

  // Now visible and on by default.
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();

  // Can be turned off.
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
});
