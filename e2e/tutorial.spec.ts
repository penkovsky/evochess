import { test, expect, type Page } from "@playwright/test";
import { firstVisitPage, freshGamePage } from "./helpers";

/**
 * The tutorial is what a new visitor is offered, so its behaviour is worth
 * guarding end to end: the unit tests in tutorial.test.ts prove the lesson
 * lines hold up, but only a real browser proves the learner can click through
 * them — and, just as importantly, ignore them.
 *
 * Black is the Easy AI here, the same opponent the game itself uses, so these
 * tests wait on the tutorial's own state rather than on any particular reply.
 */

/** Click-to-move, which the tutorial accepts alongside dragging. */
async function move(page: Page, from: string, to: string) {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

async function openLesson(page: Page, name: RegExp | string) {
  await page.getByRole("button", { name: "Show me how" }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.locator(".tutorial-lesson")).toBeVisible();
}

test("a first visit offers the tutorial beside a live board, not in front of it", async ({ page }) => {
  await firstVisitPage(page);

  // The board is the landing page; the invitation sits alongside it.
  await expect(page.locator(".board-wrap .evo-strip")).toHaveCount(2);
  await expect(page.locator(".tutorial-invite")).toBeVisible();
  await expect(page.locator(".tutorial-lesson")).toHaveCount(0);
});

test("declining the invitation dismisses it for good", async ({ page }) => {
  await firstVisitPage(page);
  await page.getByRole("button", { name: "No thanks" }).click();

  await expect(page.locator(".tutorial-invite")).toHaveCount(0);
  // The offer is replaced by a permanent way back in.
  await expect(page.getByRole("button", { name: "Learn Evo Basics" })).toBeVisible();

  await page.reload();
  await expect(page.locator(".tutorial-invite")).toHaveCount(0);
  await expect(page.locator(".board-wrap .evo-strip")).toHaveCount(2);
});

test("just starting to play dismisses the invitation", async ({ page }) => {
  await firstVisitPage(page);
  await expect(page.locator(".tutorial-invite")).toBeVisible();

  // Playing a move is one of the two valid answers to the offer, so the board
  // must be live underneath it.
  await move(page, "e2", "e4");
  await expect(page.locator(".log > div")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".tutorial-invite")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".tutorial-invite")).toHaveCount(0);
});

test("does not interrupt a returning player", async ({ page }) => {
  await freshGamePage(page);
  await expect(page.locator(".tutorial-invite")).toHaveCount(0);
  await expect(page.locator(".board-wrap .evo-strip")).toHaveCount(2);
});

test("lesson 1 teaches the first promotion against a real opponent", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await firstVisitPage(page);
  await openLesson(page, "Start lesson 1");

  // Step 1: e4. The note only appears once Black — the Easy AI — has answered.
  await move(page, "e2", "e4");
  await expect(page.locator(".tutorial-card.note")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: b3.
  await move(page, "b2", "b3");
  await expect(page.locator(".tutorial-card.note")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: the third pawn move earns a minor piece and opens the real prompt.
  await move(page, "c2", "c3");
  await expect(page.locator(".modal")).toBeVisible();
  await expect(page.locator(".tutorial-choice-prompt")).toContainText("Knight");

  await page.locator(".promo-icon[title*='Knight']").click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator('[data-square="c3"] [data-piece="wN"]')).toBeVisible();
  await expect(page.locator(".tutorial-card.note")).toBeVisible();

  await page.getByRole("button", { name: "Finish lesson" }).click();
  await expect(page.locator(".tutorial-card.outro")).toBeVisible();

  await page.locator(".tutorial-actions").getByRole("button", { name: "All lessons" }).click();
  await expect(page.locator(".lesson-card.done")).toHaveCount(1);

  // Reloading lands on the board, and reopening the tutorial from the panel
  // still shows lesson 1 as completed.
  await page.reload();
  await expect(page.locator(".board-wrap .evo-strip")).toHaveCount(2);
  await page.getByRole("button", { name: "Learn Evo Basics" }).click();
  await expect(page.locator(".lesson-card.done")).toHaveCount(1);

  expect(errors).toEqual([]);
});

test("an off-script move is played, not refused, and the game carries on", async ({ page }) => {
  await firstVisitPage(page);
  await openLesson(page, "Start lesson 1");

  // Lesson 1 suggests e4; a different legal move must simply be allowed.
  await move(page, "a2", "a4");
  await expect(page.locator(".tutorial-card.free")).toBeVisible();
  await expect(page.locator('[data-square="a4"] [data-piece]')).toBeVisible();
  await expect(page.locator('[data-square="a2"] [data-piece]')).toHaveCount(0);
  // The opponent still answers — going off-script means a real game, not a
  // frozen board.
  await expect(page.locator(".tutorial-free-status")).toContainText("White to move");

  // Play continues freely.
  await move(page, "b2", "b4");
  await expect(page.locator('[data-square="b4"] [data-piece]')).toBeVisible();
  await expect(page.locator(".tutorial-free-status")).toContainText("White to move");

  // ...and the lesson is still there to be picked back up.
  await page.getByRole("button", { name: "Replay this step" }).click();
  await expect(page.locator(".tutorial-card.instruction")).toBeVisible();
  await expect(page.locator('[data-square="a2"] [data-piece]')).toBeVisible();
  await expect(page.locator('[data-square="a4"] [data-piece]')).toHaveCount(0);
  await expect(page.locator('[data-square="b4"] [data-piece]')).toHaveCount(0);

  // The rewound step still works.
  await move(page, "e2", "e4");
  await expect(page.locator(".tutorial-card.note")).toBeVisible();
});

test("an off-script promotion choice is accepted too", async ({ page }) => {
  await firstVisitPage(page);
  await openLesson(page, "Start lesson 1");

  await move(page, "e2", "e4");
  await page.getByRole("button", { name: "Continue" }).click();
  await move(page, "b2", "b3");
  await page.getByRole("button", { name: "Continue" }).click();

  // The step suggests a Knight; taking the Bishop is a legal, sensible choice
  // and must be honoured rather than rejected.
  await move(page, "c2", "c3");
  await expect(page.locator(".modal")).toBeVisible();
  await page.locator(".promo-icon[title*='Bishop']").click();

  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator('[data-square="c3"] [data-piece="wB"]')).toBeVisible();
  await expect(page.locator(".tutorial-card.free")).toBeVisible();
});

test("rewinding mid-lesson returns to the current step, keeping earlier ones", async ({ page }) => {
  await firstVisitPage(page);
  await openLesson(page, "Start lesson 1");

  await move(page, "e2", "e4");
  await expect(page.locator(".tutorial-card.note")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Wander off on step 2, then ask for the step back.
  await move(page, "h2", "h4");
  await expect(page.locator(".tutorial-card.free")).toBeVisible();
  await page.getByRole("button", { name: "Replay this step" }).click();

  // Step 1's move survives; only the stray move is undone.
  await expect(page.locator('[data-square="e4"] [data-piece]')).toBeVisible();
  await expect(page.locator('[data-square="h4"] [data-piece]')).toHaveCount(0);
  await expect(page.locator(".tutorial-card.instruction")).toContainText("b3");
});

test("the rook-charge lesson downgrades the rook on its last charge", async ({ page }) => {
  await firstVisitPage(page);
  await openLesson(page, /Rooks burn out/);
  await expect(page.locator('[data-square="c2"] .rook-charge-badge')).toHaveText("1");

  // Spending the last charge forces the downgrade, in the same move.
  await move(page, "c2", "c7");
  await expect(page.locator(".modal")).toBeVisible();
  await page.getByRole("button", { name: "Downgrade to Bishop" }).click();

  // The Rook never really arrived: a Bishop stands on c7, with no charge badge.
  await expect(page.locator('[data-square="c7"] .rook-charge-badge')).toHaveCount(0);
  await expect(page.locator('[data-square="c7"] [data-piece="wB"]')).toBeVisible();
});
