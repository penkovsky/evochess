import { test, expect } from "@playwright/test";
import { freshGamePage } from "./helpers";

// The widget bar only exists below the 600px breakpoint in App.css; above it
// the side panel carries the same content, so every test here needs the phone
// viewport rather than Playwright's 1280x720 default.
test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await freshGamePage(page);
});

test("the widget bar replaces the side panel on a phone", async ({ page }) => {
  await expect(page.locator(".panel")).toBeHidden();

  const bar = page.locator(".mobile-bar");
  await expect(bar).toBeVisible();
  // Four, not five: nothing has answered the puzzle query here, so the puzzle
  // button is hidden entirely. The rules summary is no longer in the bar at
  // all — it moved into the settings sheet to make room for it.
  await expect(bar.locator(".widget-btn")).toHaveCount(4);
  for (const name of ["Learn Evo Basics", "Move log", "Settings", "Share position"]) {
    await expect(bar.getByRole("button", { name })).toBeVisible();
  }
  await expect(bar.getByRole("button", { name: "Rules summary" })).toHaveCount(0);

  await page.screenshot({ path: "e2e/__screenshots__/mobile-widget-bar.png", fullPage: true });
});

test("tapping a widget icon slides up a sheet; the backdrop closes it", async ({ page }) => {
  const settings = page.locator(".mobile-bar").getByRole("button", { name: "Settings" });
  await expect(page.locator(".sheet")).toHaveCount(0);

  await settings.click();
  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  // The rules ride along below the settings switches, which is the phone route
  // to them now the puzzle button has the slot they used to have.
  await expect(sheet).toContainText("Castling is not defined.");
  // The board stays visible above the sheet — that's the point of a drawer.
  await expect(page.locator("[data-column]").first()).toBeVisible();

  await page.screenshot({ path: "e2e/__screenshots__/mobile-widget-sheet.png" });

  // Clicking the backdrop (top of the screen, clear of the sheet) closes it.
  await page.locator(".sheet-backdrop").click({ position: { x: 195, y: 40 } });
  await expect(page.locator(".sheet")).toHaveCount(0);
});

test("the move log sheet says so when there is nothing to show, and Escape closes it", async ({
  page,
}) => {
  const sheet = page.locator(".sheet");

  await page.locator(".mobile-bar").getByRole("button", { name: "Move log" }).click();
  // An unplayed game must still give the sheet a body — height:auto on an
  // empty log otherwise collapses the drawer to a bare title.
  await expect(sheet.locator(".log")).toBeVisible();
  await expect(sheet.locator(".log")).toContainText("No moves yet.");

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("the close button dismisses the sheet", async ({ page }) => {
  const log = page.locator(".mobile-bar").getByRole("button", { name: "Move log" });

  await log.click();
  await page.locator(".sheet").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  // Reopening works; note there is deliberately no icon-toggles-closed case —
  // the backdrop covers the bar, so any tap while a sheet is open dismisses it.
  await log.click();
  await expect(page.locator(".sheet")).toBeVisible();
});

test("the tutorial icon opens the tutorial and no sheet", async ({ page }) => {
  await page.locator(".mobile-bar").getByRole("button", { name: "Learn Evo Basics" }).click();

  await expect(page.locator(".sheet")).toHaveCount(0);
  await expect(page.locator(".tutorial")).toBeVisible();
});
