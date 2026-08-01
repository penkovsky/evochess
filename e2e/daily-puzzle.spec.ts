/**
 * `?daily`. The collector request is stubbed with
 * `page.route`, so nothing here depends on a row existing anywhere.
 *
 * The collector host comes from `playwright.config.ts`'s webServer env: the
 * request is only made at all when the app is built with both telemetry values
 * set, and nothing listens on that host, so every route below has to be
 * fulfilled rather than left to the network.
 *
 * The payloads are built by the real encoder rather than pasted in, so this
 * spec cannot drift from the codec.
 */
import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import type { Square } from "chess.js";
import { EvoChessGame } from "../src/evochess/game";
import { serializeGame } from "../src/evochess/serialize";
import { encodeShareLink } from "../src/evochess/shareLink";

const TUTORIAL_KEY = "evochess-tutorial-v1";
const SAVE_KEY = "evochess-save-v3";

/** `data/games/game1.txt` replayed to a given ply. */
function game1(plies: number): EvoChessGame {
  const moves: Array<[string, object]> = [
    ["e2e4", {}], ["g7g5", {}], ["d2d4", {}], ["b7b6", {}],
    ["g2g3", { minorPromo: "b" }], ["c7c6", {}], ["g3b8", {}], ["a7a6", {}],
    ["b8c7", {}], ["a6a5", { minorPromo: "b" }], ["c2c3", {}], ["g5g4", {}],
  ];
  const game = new EvoChessGame();
  for (const [uci, options] of moves.slice(0, plies)) {
    game.applyMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, options);
  }
  return game;
}

/** White to move, with `Bb8=R#` available: the puzzle. */
const PUZZLE_PARAM = encodeShareLink(game1(12));
/** Black to move: the `?p=` position, so the two are told apart on sight. */
const LINK_PARAM = encodeShareLink(game1(11));

const ROW = { publish_date: "2026-08-01", param: PUZZLE_PARAM, mate_in: 2 };

/** An autosave for the player's own in-progress game, one move deep. */
function ownGameSave(): string {
  const game = new EvoChessGame();
  game.applyMove("e2", "e4");
  return JSON.stringify({
    ...serializeGame(game),
    mode: "human-human",
    aiColor: "b",
    level: "zen",
    autoFlip: true,
    timerEnabled: false,
    timerMinutes: 10,
    clock: { w: 600, b: 600 },
    ponderEnabled: true,
    fromShared: false,
    unverified: false,
    telemetry: {
      uid: "e2e-daily",
      startFen: new EvoChessGame().chess.fen(),
      startParam: null,
      activeMs: 0,
      lastPlyAt: null,
      lastPlies: 0,
      takebacks: 0,
      started: true,
      logged: false,
    },
  });
}

interface Collector {
  /** Every row posted to `events`, in the order the client sent them. */
  events: Array<{ name: string; props: Record<string, unknown> }>;
  /** Every row posted to `games`. */
  games: Array<Record<string, unknown>>;
  /** How many times the puzzle row was asked for. */
  puzzleRequests: string[];
}

/**
 * Stubs the three endpoints. `puzzle` null answers the puzzle query with a
 * 500, which is the "failed request" case; otherwise the row is returned.
 */
async function stubCollector(page: Page, puzzle: object | null): Promise<Collector> {
  const collector: Collector = { events: [], games: [], puzzleRequests: [] };
  await page.route("**/rest/v1/puzzles*", (route: Route) => {
    collector.puzzleRequests.push(route.request().url());
    if (!puzzle) return route.fulfill({ status: 500, body: "" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([puzzle]),
    });
  });
  await page.route("**/rest/v1/events", (route: Route) => {
    collector.events.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, body: "" });
  });
  await page.route("**/rest/v1/games", (route: Route) => {
    collector.games.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, body: "" });
  });
  return collector;
}

/** Lands on `path`, past the tutorial, optionally over a seeded autosave. */
async function open(page: Page, path: string, seed?: Record<string, string>) {
  await page.addInitScript(
    ([key]) => {
      window.localStorage.setItem(key!, JSON.stringify({ completed: [], seen: true }));
    },
    [TUTORIAL_KEY] as const
  );
  if (seed) {
    // Written through the page rather than from an init script, which would
    // re-seed it on every later navigation.
    await page.goto("./");
    await page.evaluate((entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    }, Object.entries(seed));
  }
  await page.goto(path);
  await expect(page.locator("[data-column]").first()).toBeVisible();
}

/** The events of one name, once the queue has had a chance to drain. */
async function eventsNamed(page: Page, collector: Collector, name: string) {
  await expect
    .poll(() => collector.events.filter((e) => e.name === name).length)
    .toBeGreaterThan(0);
  return collector.events.filter((e) => e.name === name);
}

test("?daily loads today's puzzle and takes the parameter out of the address bar", async ({ page }) => {
  const collector = await stubCollector(page, ROW);
  await open(page, "./?daily");

  // The bishop on c7 is the piece the puzzle exists for, and the solver moves
  // first, so loading it must not start an engine search.
  await expect(page.locator(".board-status")).toHaveText("White to move.");
  await expect(page.locator('[data-square="c7"] img, [data-square="c7"] svg')).toBeVisible();

  // Stripped immediately, so a reload cannot re-enter the puzzle over a game
  // in progress. `?p=` is not put in its place either: the puzzle is held in
  // memory like any shared position until the first move.
  expect(new URL(page.url()).searchParams.has("daily")).toBe(false);
  expect(new URL(page.url()).searchParams.get("p")).toBeNull();

  const opens = await eventsNamed(page, collector, "puzzle_open");
  expect(opens).toHaveLength(1);
  expect(opens[0].props).toMatchObject({ date: "2026-08-01", mate_in: 2 });
});

test("?p= wins when both are present", async ({ page }) => {
  const collector = await stubCollector(page, ROW);
  await open(page, `./?p=${LINK_PARAM}&daily`);

  // The link's position, not the puzzle's: Black to move.
  await expect(page.locator(".board-status")).toHaveText("Black to move.");
  // And the puzzle was never asked for, so nothing can arrive later and take
  // the board off the link.
  await page.waitForTimeout(1000);
  expect(collector.puzzleRequests).toHaveLength(0);
  await expect(page.locator(".board-status")).toHaveText("Black to move.");
});

test("a failed request leaves the board on the resumed autosave", async ({ page }) => {
  const save = ownGameSave();
  const collector = await stubCollector(page, null);
  await open(page, "./?daily", { [SAVE_KEY]: save });

  await expect.poll(() => collector.puzzleRequests.length).toBe(1);
  // The request carries no date: the policy caps the result at today, and that
  // is the whole security model.
  expect(collector.puzzleRequests[0]).not.toMatch(/\d{4}-\d{2}-\d{2}/);

  // The player's own game, one move deep, undisturbed.
  await page.waitForTimeout(500);
  await expect(page.locator(".log > div")).toHaveCount(1);
  await expect(page.locator(".log > div").first()).toHaveText("1. e4");
  expect(collector.events.some((e) => e.name === "puzzle_open")).toBe(false);
});

test("the puzzle leaves the player's own game saved and restorable", async ({ page }) => {
  const save = ownGameSave();
  await stubCollector(page, ROW);
  await open(page, "./?daily", { [SAVE_KEY]: save });

  await expect(page.locator(".board-status")).toHaveText("White to move.");
  // The player's game is still in the autosave and unchanged, and the puzzle
  // is held in memory on top of it (share-links-spec.md §6.4).
  //
  // Not byte for byte, unlike the `?p=` spec: the puzzle arrives from a
  // promise, so the resumed game gets one ordinary save in between, which
  // re-anchors the telemetry ply clock. Everything about the game itself has
  // to be identical.
  const stored = JSON.parse(
    (await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY))!
  );
  const { telemetry, ...game } = stored;
  const { telemetry: _seeded, ...seededGame } = JSON.parse(save);
  expect(game).toEqual(seededGame);
  expect(telemetry.uid).toBe("e2e-daily");

  await page.getByRole("button", { name: "Back to my game" }).click();
  await expect(page.locator(".log > div")).toHaveCount(1);
  await expect(page.locator(".log > div").first()).toHaveText("1. e4");
});

test("solving the puzzle reports it solved and tags the game row", async ({ page }) => {
  const collector = await stubCollector(page, ROW);
  await open(page, "./?daily");

  await expect(page.locator(".board-status")).toHaveText("White to move.");
  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();
  await page.locator('.promo-icon[title="Promote moved minor piece → Rook"]').click();

  await expect(page.locator(".board-status")).toHaveText("Checkmate - White wins");
  // Mate on the solver's first move of a mate-in-2 is a solve, not a failure.
  const solved = await eventsNamed(page, collector, "puzzle_solved");
  expect(solved).toHaveLength(1);
  expect(solved[0].props).toMatchObject({ date: "2026-08-01", mate_in: 2 });
  expect(collector.events.some((e) => e.name === "puzzle_failed")).toBe(false);

  // The attempt is a real game down the shared-position path, so the tag is
  // what keeps it out of the ordinary game numbers.
  const ends = await eventsNamed(page, collector, "game_end");
  expect(ends[0].props).toMatchObject({ puzzle_date: "2026-08-01", from_shared: true });
  await expect.poll(() => collector.games.length).toBe(1);
  expect(collector.games[0]).toMatchObject({ puzzle_date: "2026-08-01", from_shared: true });
});
