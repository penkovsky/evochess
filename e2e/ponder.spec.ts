import { test, expect } from "@playwright/test";

// Milestone 4 verification (docs/ponder-spec.md §9): a takeback during a deep
// ponder must yield a legal, playable position promptly, with no console
// errors — the priority-#1 regression guard from §1 ("the ponder must stop
// the instant the human moves"), exercised end-to-end against the real
// worker rather than through a direct-call harness.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("./");
});

test("takeback during a deep ponder yields a playable position promptly, with no console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  // Default setup: Human vs AI, AI plays Black, level Fun — ponder is on by
  // default (§5.5). Human (White) moves first via click-to-move.
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();

  // Wait for the AI's reply — it becomes the human's turn again, and the
  // worker (per maybeAiMove) immediately starts pondering that position.
  await expect(page.locator(".log > div")).toHaveCount(1, { timeout: 5000 });

  // Let the ponder chain run for a while so it's genuinely "deep" — several
  // slices of SLICE_MS=60ms each — before interrupting it.
  await page.waitForTimeout(3000);

  const takebackButton = page.getByRole("button", { name: "Takeback" });
  await expect(takebackButton).toBeEnabled();
  await takebackButton.click();

  // The takeback must land promptly: the move log clears (back to the
  // opening) well within a few seconds, not stalled behind an unbounded
  // ponder search.
  await expect(page.locator(".log > div")).toHaveCount(0, { timeout: 2000 });

  // The position must still be playable immediately afterward — the worker
  // wasn't left wedged by the interrupted ponder.
  await page.locator('[data-square="d2"]').click();
  await page.locator('[data-square="d4"]').click();
  await expect(page.locator(".log > div")).toHaveCount(1, { timeout: 5000 });

  expect(errors).toEqual([]);
});
