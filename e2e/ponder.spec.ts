import { test, expect } from "@playwright/test";
import { freshGamePage, silenceCollector } from "./helpers";

// Milestone 4 verification (docs/ponder-spec.md §9): a takeback during a deep
// ponder must yield a legal, playable position promptly, with no console
// errors — the priority-#1 regression guard from §1 ("the ponder must stop
// the instant the human moves"), exercised end-to-end against the real
// worker rather than through a direct-call harness.
test.beforeEach(async ({ page }) => {
  // Before the first navigation, so the load-time telemetry is caught too: a
  // refused collector request would show up in the console assertion below.
  await silenceCollector(page);
  await freshGamePage(page);
  // Pondering runs at Fun only (`maybeStartPonder`), and the app opens on Zen,
  // so every test here has to select the level rather than inherit it. Safe
  // before the first move: the level picker only asks for confirmation once a
  // game is in progress.
  await page.getByRole("button", { name: "Fun" }).click();
});

test("takeback during a deep ponder yields a playable position promptly, with no console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  // Setup: Human vs AI by default, AI plays White and opens, level Fun from
  // the beforeEach, ponder on by default (§5.5). The human answers as Black
  // via click-to-move.
  await expect(page.locator(".panel .log .log-move")).toHaveCount(1, { timeout: 5000 });
  await page.locator('[data-square="e7"]').click();
  await page.locator('[data-square="e5"]').click();

  // Wait for the AI's reply — it becomes the human's turn again, and the
  // worker (per maybeAiMove) immediately starts pondering that position.
  await expect(page.locator(".panel .log .log-move")).toHaveCount(3, { timeout: 5000 });

  // Let the ponder chain run for a while so it's genuinely "deep" — several
  // slices of SLICE_MS=60ms each — before interrupting it.
  await page.waitForTimeout(3000);

  const takebackButton = page.getByRole("button", { name: "Takeback" });
  await expect(takebackButton).toBeEnabled();
  await takebackButton.click();

  // The takeback must land promptly: the move log rolls back to the AI's
  // opening, the most recent position with the human to move, well within a
  // few seconds and not stalled behind an unbounded ponder search.
  await expect(page.locator(".panel .log .log-move")).toHaveCount(1, { timeout: 2000 });

  // The position must still be playable immediately afterward — the worker
  // wasn't left wedged by the interrupted ponder.
  await page.locator('[data-square="d7"]').click();
  await page.locator('[data-square="d5"]').click();
  await expect(page.locator(".panel .log .log-move")).toHaveCount(3, { timeout: 5000 });

  expect(errors).toEqual([]);
});

// A takeback that lands on the human's move must leave them *with* a ponder,
// not without one: `takeback` sends `reset` (killing the chain and wiping the
// TT, §5.3/§6.2), so unless it also starts a fresh chain the rest of that turn
// is thought-free — the position is back under the human's control and the
// engine is idle until the AI's next reply.
test("takeback restarts pondering on the restored position", async ({ page }) => {
  // The ponder-status console line (App.tsx) is the only observable a chain
  // emits, and its `elapsed` is measured from the chain's own start. So a
  // status with a small elapsed, arriving after we've already let a chain run
  // for seconds, can only come from a chain *created* after the takeback —
  // which is exactly the claim. (Depth is no use here: a 60ms slice completes
  // several iterations, so a fresh ladder's first report is mid-single-digits,
  // the same range an established chain sits in.)
  const elapsedOf = (line: string) => Number(/elapsed=(\d+)ms/.exec(line)?.[1] ?? NaN);
  const ponderLines: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().startsWith("[EvoChess ponder] phase=")) ponderLines.push(msg.text());
  });

  await expect(page.locator(".panel .log .log-move")).toHaveCount(1, { timeout: 5000 });
  await page.locator('[data-square="e7"]').click();
  await page.locator('[data-square="e5"]').click();
  await expect(page.locator(".panel .log .log-move")).toHaveCount(3, { timeout: 5000 });

  // Let the post-reply chain run long enough that anything it still has to say
  // carries a large elapsed, and so can't be mistaken for a fresh chain.
  await page.waitForTimeout(2000);
  expect(ponderLines.length).toBeGreaterThan(0); // the feature is on at all

  const takebackButton = page.getByRole("button", { name: "Takeback" });
  await expect(takebackButton).toBeEnabled();
  await takebackButton.click();
  await expect(page.locator(".panel .log .log-move")).toHaveCount(1, { timeout: 2000 });

  ponderLines.length = 0;
  await expect
    .poll(() => ponderLines.some((l) => l.startsWith("[EvoChess ponder] phase=position") && elapsedOf(l) < 1000), {
      timeout: 5000,
    })
    .toBe(true);
});
