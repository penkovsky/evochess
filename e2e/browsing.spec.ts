import { test, expect, type Page } from "@playwright/test";
import { freshGamePage, startOverTheBoard } from "./helpers";

/**
 * Playwright's touchscreen has no swipe primitive, so the pair of events the
 * board listens for is dispatched by hand. `withStart: false` sends the
 * touchend alone, which is how a gesture that began outside the board arrives.
 */
async function swipe(page: Page, fromX: number, toX: number, withStart = true) {
  await page.evaluate(
    ([fromX, toX, withStart]) => {
      const el = document.querySelector(".board-container")!;
      const touch = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
      if (withStart) {
        el.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(fromX as number)], bubbles: true }));
      }
      el.dispatchEvent(new TouchEvent("touchend", { changedTouches: [touch(toX as number)], bubbles: true }));
    },
    [fromX, toX, withStart] as [number, number, boolean]
  );
}

/** Four plies of a human-vs-human game, so there is a line to step through. */
async function playFourPlies(page: Page) {
  await freshGamePage(page);
  await startOverTheBoard(page);
  for (const [from, to] of [
    ["e2", "e4"],
    ["e7", "e5"],
    ["d2", "d4"],
    ["d7", "d5"],
  ]) {
    await page.locator(`[data-square="${from}"]`).click();
    await page.locator(`[data-square="${to}"]`).click();
  }
  await expect(page.locator(".log > div")).toHaveCount(2);
}

const live = (page: Page) => page.getByRole("button", { name: "Back to the live position" });

test("arrow keys step through the game, Home and End jump to its ends", async ({ page }) => {
  await playFourPlies(page);
  const status = page.locator(".board-status");

  // ArrowLeft from the live position enters browsing at the last recorded ply.
  await page.keyboard.press("ArrowLeft");
  await expect(status).toContainText("Move 3 of 4");
  await page.keyboard.press("ArrowLeft");
  await expect(status).toContainText("Move 2 of 4");
  await page.keyboard.press("ArrowRight");
  await expect(status).toContainText("Move 3 of 4");

  await page.keyboard.press("Home");
  await expect(status).toContainText("Start position");
  await page.keyboard.press("End");
  await expect(live(page)).toHaveCount(0);
});

test("the chevrons step, and holding one runs to the end of the line", async ({ page }) => {
  await playFourPlies(page);
  const status = page.locator(".board-status");

  await page.keyboard.press("Home");
  await expect(status).toContainText("Start position");
  // Nothing before the start position to step to.
  await expect(page.getByRole("button", { name: "Previous move" })).toBeDisabled();
  await page.getByRole("button", { name: "Next move" }).click();
  await expect(status).toContainText("Move 1 of 4");

  // A hold runs to the live position, and the click that follows the release
  // is swallowed — otherwise it would step once more and undo the jump.
  const next = page.getByRole("button", { name: "Next move" });
  const box = (await next.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(live(page)).toHaveCount(0);
});

test("swiping the board steps through the line while browsing", async ({ page }) => {
  await playFourPlies(page);
  const status = page.locator(".board-status");

  await page.getByRole("button", { name: "Previous move" }).click();
  await expect(status).toContainText("Move 3 of 4");

  // Rightward goes back, leftward forward.
  await swipe(page, 100, 200);
  await expect(status).toContainText("Move 2 of 4");
  await swipe(page, 200, 100);
  await expect(status).toContainText("Move 3 of 4");

  // A touchend with no touchstart of its own is not a swipe...
  await swipe(page, 100, 200, false);
  await expect(status).toContainText("Move 3 of 4");
  // ...and neither is a movement under the 40px threshold, which would
  // otherwise turn every tap on the board into a step.
  await swipe(page, 200, 190);
  await expect(status).toContainText("Move 3 of 4");
});
