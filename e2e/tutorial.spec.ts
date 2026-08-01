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

  // Step 1: e4. Once Black — the Easy AI — has answered, the next step arrives
  // on its own: what the move did leads the card the next instruction is on,
  // so there is nothing to click through between moves.
  await move(page, "e2", "e4");
  const instruction = page.locator(".tutorial-card.instruction");
  await expect(instruction).toContainText("One green dot");
  await expect(instruction).toContainText("b3");

  // Step 2: b3, and again straight on to step 3.
  await move(page, "b2", "b3");
  await expect(instruction).toContainText("Two dots");
  await expect(instruction).toContainText("c3");

  // Step 3: the third pawn move earns a minor piece and opens the real prompt.
  await move(page, "c2", "c3");
  await expect(page.locator(".modal")).toBeVisible();
  await expect(page.locator(".tutorial-choice-prompt")).toContainText("Knight");

  await page.locator(".promo-icon[title*='Knight']").click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator('[data-square="c3"] [data-piece="wN"]')).toBeVisible();

  // The last step's payoff heads the outro rather than delaying it.
  const outro = page.locator(".tutorial-card.outro");
  await expect(outro).toBeVisible();
  await expect(outro).toContainText("now a Knight");
  await expect(page.getByRole("button", { name: "Finish lesson" })).toHaveCount(0);

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

test("an off-script promotion choice is accepted too", async ({ page }) => {
  await firstVisitPage(page);
  await openLesson(page, "Start lesson 1");

  await move(page, "e2", "e4");
  await expect(page.locator(".tutorial-card.instruction")).toContainText("b3");
  await move(page, "b2", "b3");
  await expect(page.locator(".tutorial-card.instruction")).toContainText("c3");

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
  await expect(page.locator(".tutorial-card.instruction")).toContainText("b3");

  // Wander off on step 2, then ask for the step back.
  await move(page, "h2", "h4");
  await expect(page.locator(".tutorial-card.free")).toBeVisible();
  await page.getByRole("button", { name: "Replay this step" }).click();

  // Step 1's move survives; only the stray move is undone.
  await expect(page.locator('[data-square="e4"] [data-piece]')).toBeVisible();
  await expect(page.locator('[data-square="h4"] [data-piece]')).toHaveCount(0);
  await expect(page.locator(".tutorial-card.instruction")).toContainText("b3");
});

test("finishing a lesson hands the position over rather than freezing it", async ({ page }) => {
  await firstVisitPage(page);
  await openLesson(page, /Minors earn Rooks/);

  // The lesson itself: the Bishop's third minor move arrives on a8 as a Rook,
  // giving check, and Black's only answer is to block on d8.
  await move(page, "g2", "a8");
  await page.locator(".promo-icon[title*='Rook']").click();
  await expect(page.locator('[data-square="a8"] [data-piece="wR"]')).toBeVisible();

  // The reply flows straight into the outro — no intermediate screen, and
  // nothing to click through.
  await expect(page.locator('[data-square="d8"] [data-piece="bR"]')).toBeVisible();
  await expect(page.locator(".tutorial-card.outro")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish lesson" })).toHaveCount(0);

  // The outro is not a full stop: the board is still live, and this position
  // is mate in one. Taking it must work, and must not throw the outro away.
  await move(page, "a8", "d8");
  await expect(page.locator('[data-square="d8"] [data-piece="wR"]')).toBeVisible();
  await expect(page.locator(".tutorial-card.outro")).toContainText("Checkmate");
  await expect(page.locator(".tutorial-actions").getByRole("button", { name: "Next lesson" })).toBeVisible();
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
