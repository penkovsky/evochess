/**
 * The sharer's side of a history link (share-links-spec.md §4.4): a link built
 * while browsing arrives at that ply with the whole line behind and ahead of
 * it. Run at a phone viewport, since that is the primary target.
 */
import { test, expect, type Page } from "@playwright/test";
import { freshGamePage } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

/** Four plies of a human-vs-human game, so there is a line to step through. */
async function playFourPlies(page: Page) {
  await freshGamePage(page);
  // The mode picker is in the side panel, which this viewport hides: on a
  // phone the same controls live in the settings sheet.
  await page.locator(".mobile-bar").getByRole("button", { name: "Settings" }).click();
  await page.locator(".sheet").getByRole("button", { name: "vs Human" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sheet")).toHaveCount(0);
  for (const [from, to] of [
    ["e2", "e4"],
    ["e7", "e5"],
    ["d2", "d4"],
    ["d7", "d5"],
  ]) {
    await page.locator(`[data-square="${from}"]`).click();
    await page.locator(`[data-square="${to}"]`).click();
  }
}

/** Opens the dialog from the mobile bar and returns the link it built. */
async function shareUrl(page: Page): Promise<string> {
  await page.locator(".mobile-bar").getByRole("button", { name: "Share position" }).click();
  const url = await page.locator(".share-url").inputValue();
  // Escape rather than a Close button: the dialog has two of those, the header
  // × and the one under the move log.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Share" })).toHaveCount(0);
  return url;
}

/** The board and both evo strips fit the viewport without scrolling, which is
 *  the phone-first rule a shared link has to keep too. */
async function expectNoScrolling(page: Page) {
  await expect(page.locator(".board-wrap .evo-strip")).toHaveCount(2);
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    board: document.querySelector(".board-wrap")!.getBoundingClientRect().bottom,
    height: window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.board).toBeLessThanOrEqual(overflow.height);
}

test("a link shared while browsing opens at that ply, with the line either side", async ({ page }) => {
  await playFourPlies(page);

  // Back two plies, so the cursor is neither the start nor the live position:
  // both of those would look plausible on a broken off-by-one.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".board-status")).toContainText("Move 2 of 4");
  const url = await shareUrl(page);

  await page.goto(url);
  await expect(page.locator("[data-column]").first()).toBeVisible();

  // The recipient lands on the ply the sharer was looking at, not on the end
  // of the line.
  await expect(page.locator(".board-status")).toContainText("Move 2 of 4");
  await expect(page.locator('[data-square="d4"] img, [data-square="d4"] svg')).toHaveCount(0);
  await expectNoScrolling(page);

  // The whole line is there, both ways.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".board-status")).toContainText("Move 1 of 4");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".board-status")).toContainText("Move 3 of 4");
  await page.keyboard.press("End");
  await expect(page.locator(".log > div")).toHaveCount(2);
  await expect(page.locator('[data-square="d5"] img, [data-square="d5"] svg')).toBeVisible();
});

test("a link shared from the live position arrives live and playable", async ({ page }) => {
  await playFourPlies(page);
  const url = await shareUrl(page);

  await page.goto(url);
  await expect(page.locator("[data-column]").first()).toBeVisible();
  // Live, so no browsing status and the move log is the sharer's.
  await expect(page.locator(".board-status")).toHaveText("White to move.");
  await expect(page.locator(".log > div")).toHaveCount(2);
  // And the line behind it is still walkable.
  await page.keyboard.press("Home");
  await expect(page.locator(".board-status")).toContainText("Start position");
});

test("browsing a resumed game survives a reload, and so does its history link", async ({ page }) => {
  await playFourPlies(page);
  await expect(page.locator(".log > div")).toHaveCount(2);

  // `historyRef` is memory-only. Without the startup replay a reload leaves
  // nothing to step back through.
  await page.reload();
  await expect(page.locator(".log > div")).toHaveCount(2);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".board-status")).toContainText("Move 3 of 4");
  await page.keyboard.press("Home");
  await expect(page.locator(".board-status")).toContainText("Start position");

  const url = await shareUrl(page);
  await page.goto(url);
  await expect(page.locator(".board-status")).toContainText("Start position");
  await page.keyboard.press("End");
  await expect(page.locator(".log > div")).toHaveCount(2);
});
