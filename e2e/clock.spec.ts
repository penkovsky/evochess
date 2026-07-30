import { test, expect } from "@playwright/test";
import { freshGamePage } from "./helpers";

// The clock is human-vs-human only, off by default, and its minutes field
// locks once a game is under way — so every test here sets it up before the
// first move (src/hooks/useGameClock.ts, ControlsPanel.tsx).
test.beforeEach(async ({ page }) => {
  await freshGamePage(page);
  await page.getByRole("button", { name: "vs Human" }).click();
  await page.getByRole("button", { name: "Clock" }).click();
  await page.getByLabel("Minutes per side:").fill("1");
});

test("the clock is armed but does not run until the first move", async ({ page }) => {
  const white = page.locator(".clock").first();
  await expect(white).toContainText("1:00");
  // Long enough that a running clock would have shown 0:59 by now.
  await page.waitForTimeout(1500);
  await expect(white).toContainText("1:00");
});

test("only the side to move loses time", async ({ page }) => {
  const white = page.locator(".clock").first();
  const black = page.locator(".clock").nth(1);

  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator(".log > div")).toHaveCount(1);

  // White's reading freezes where the move left it; Black's counts down.
  const whiteAfterMove = await white.textContent();
  await expect(black).toHaveClass(/active/);
  await expect(black).not.toContainText("1:00");
  expect(await white.textContent()).toBe(whiteAfterMove);
});

test("a takeback restores the readings captured with the ply, not a fresh clock", async ({ page }) => {
  const white = page.locator(".clock").first();
  const black = page.locator(".clock").nth(1);

  // Two plies, so the snapshot the takeback lands on has one side already down
  // some time. A clock that was merely reset would show 1:00 on both.
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(black).not.toContainText("1:00");
  await page.locator('[data-square="e7"]').click();
  await page.locator('[data-square="e5"]').click();
  await expect(page.locator(".log > div")).toHaveCount(1);
  await expect(white).not.toContainText("1:00");
  const blackAtSnapshot = await black.textContent();

  await page.getByRole("button", { name: "Takeback" }).click();
  // Back to Black's move: White is whole again, Black keeps what it had spent.
  await expect(white).toContainText("1:00");
  await expect(black).toHaveText(blackAtSnapshot!);
});
