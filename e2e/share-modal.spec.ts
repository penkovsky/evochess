/**
 * The Share dialog's two halves: the position as a link, and the move log as
 * text. Both buttons open it, and the move-log copy only makes sense once
 * something has been played.
 */
import { test, expect } from "@playwright/test";
import { freshGamePage } from "./helpers";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshGamePage(page);
  // Human vs human, so the engine doesn't reply in the middle of the moves
  // this spec plays.
  await page.getByRole("button", { name: "vs Human" }).click();
});

async function play(page: import("@playwright/test").Page, from: string, to: string) {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

test("copies the move log as numbered text", async ({ page }) => {
  await play(page, "e2", "e4");
  await play(page, "e7", "e5");
  await play(page, "d2", "d4");

  await page.getByRole("button", { name: "Share position" }).first().click();
  await expect(page.getByRole("dialog", { name: "Share" })).toBeVisible();
  await page.getByRole("button", { name: "Copy move log" }).click();

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("1. e4 e5\n2. d4");
});

test("offers no move-log copy before a move is played", async ({ page }) => {
  await page.getByRole("button", { name: "Share position" }).first().click();
  await expect(page.getByRole("dialog", { name: "Share" }).getByText("No moves yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy move log" })).toBeDisabled();
});

test("the link half still copies the URL", async ({ page }) => {
  await play(page, "e2", "e4");
  await page.getByRole("button", { name: "Share position" }).first().click();
  await page.getByRole("button", { name: "Copy link" }).click();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("?p=");
});
