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
      abandonedAtPly: null,
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

/** A match with a free seat, so `?lm=` puts one on the board as an observer. */
async function stubMatch(page: Page) {
  await page.route("**/rest/v1/rpc/lm_fetch", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "waiting",
        first_mover: "b",
        start_payload: LINK_PARAM,
        joined: false,
        free_seat: "b",
        moves: [],
      }),
    })
  );
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
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
  await expect(page.locator('[data-square="c7"] img, [data-square="c7"] svg')).toBeVisible();

  // Stripped immediately, so a reload cannot re-enter the puzzle over a game
  // in progress. `?p=` is not put in its place either: the puzzle is held in
  // memory like any shared position until the first move.
  expect(new URL(page.url()).searchParams.has("daily")).toBe(false);
  expect(new URL(page.url()).searchParams.get("p")).toBeNull();

  const opens = await eventsNamed(page, collector, "puzzle_open");
  expect(opens).toHaveLength(1);
  expect(opens[0].props).toMatchObject({ date: "2026-08-01", mate_in: 2, attempts: 1 });

  // The banner says which day it is for, in UTC, since one global boundary is
  // what makes "today's puzzle" mean the same thing everywhere.
  await expect(page.locator(".link-banner")).toHaveText(/Puzzle of 1 August 2026 \(UTC\)/);
});

test("?p= wins when both are present", async ({ page }) => {
  const collector = await stubCollector(page, ROW);
  await open(page, `./?p=${LINK_PARAM}&daily`);

  // The link's position, not the puzzle's: Black to move.
  await expect(page.locator(".board-status")).toHaveText("Black to move.");
  // The row is still asked for — every load asks, so the entry point can know
  // there is a puzzle — but it only offers itself. Nothing arrives later and
  // takes the board off the link. (The count is a floor, not an equality: the
  // dev server runs under StrictMode, which invokes the startup effect twice.)
  await expect.poll(() => collector.puzzleRequests.length).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  await expect(page.locator(".board-status")).toHaveText("Black to move.");
  expect(collector.events.some((e) => e.name === "puzzle_open")).toBe(false);
  await expect(page.getByRole("button", { name: "Puzzle of the day" })).toBeVisible();
});

test("a failed request leaves the board on the resumed autosave", async ({ page }) => {
  const save = ownGameSave();
  const collector = await stubCollector(page, null);
  await open(page, "./?daily", { [SAVE_KEY]: save });

  // Every load asks now, not only `?daily`: the entry point has to know there
  // is a puzzle before the player asks for one.
  await expect.poll(() => collector.puzzleRequests.length).toBeGreaterThan(0);
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

  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
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

  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();
  await page.locator('.promo-icon[title="Promote moved minor piece → Rook"]').click();

  await expect(page.locator(".board-status")).toHaveText("Checkmate - White wins");
  // Mate on the solver's first move of a mate-in-2 is a solve, not a failure.
  const solved = await eventsNamed(page, collector, "puzzle_solved");
  expect(solved).toHaveLength(1);
  expect(solved[0].props).toMatchObject({ date: "2026-08-01", mate_in: 2, attempts: 1 });
  expect(collector.events.some((e) => e.name === "puzzle_failed")).toBe(false);

  // …and the board says so, over the board itself, with no way onward but New
  // Game or "back to my game", both already on screen.
  await expect(page.locator(".puzzle-overlay")).toHaveText("Solved! Mate in 2.");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

  // The attempt is a real game down the shared-position path, so the tag is
  // what keeps it out of the ordinary game numbers.
  const ends = await eventsNamed(page, collector, "game_end");
  expect(ends[0].props).toMatchObject({ puzzle_date: "2026-08-01", from_shared: true });
  await expect.poll(() => collector.games.length).toBe(1);
  expect(collector.games[0]).toMatchObject({ puzzle_date: "2026-08-01", from_shared: true });
});

test("the entry point is hidden without a puzzle and offers one with it", async ({ page }) => {
  // Nothing answers, so there is nothing to offer: no disabled state, no
  // spinner, no placeholder.
  await stubCollector(page, null);
  await open(page, "./");
  await page.waitForTimeout(500);
  await expect(page.locator(".panel").getByRole("button", { name: "Puzzle of the day" })).toHaveCount(0);

  // A row comes back on the next load, and both routes to it appear.
  await stubCollector(page, ROW);
  await open(page, "./");
  await expect(page.locator(".panel").getByRole("button", { name: "Puzzle of the day" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  const bar = page.locator(".mobile-bar");
  await expect(bar.getByRole("button", { name: "Puzzle of the day" })).toBeVisible();
  // Five is what fits at 320px with thumb-sized targets, and the bar must not
  // wrap or scroll sideways.
  await expect(bar.locator(".widget-btn")).toHaveCount(5);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the button loads the puzzle without disturbing the player's own game", async ({ page }) => {
  const save = ownGameSave();
  const collector = await stubCollector(page, ROW);
  await open(page, "./", { [SAVE_KEY]: save });

  // Their own game, one move deep, is what is on the board first.
  await expect(page.locator(".panel .log > div")).toHaveCount(1);
  await page.locator(".panel").getByRole("button", { name: "Puzzle of the day" }).click();

  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
  await expect(page.locator(".link-banner")).toHaveText(/Puzzle of 1 August 2026 \(UTC\)/);
  const opens = await eventsNamed(page, collector, "puzzle_open");
  expect(opens[0].props).toMatchObject({ date: "2026-08-01", attempts: 1 });

  // Before a move: the autosave is untouched and the way back is the banner's.
  const stored = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), SAVE_KEY))!);
  const { telemetry: _t, ...game } = stored;
  const { telemetry: _s, ...seeded } = JSON.parse(save);
  expect(game).toEqual(seeded);
  await page.getByRole("button", { name: /Back to my game/ }).click();
  await expect(page.locator(".panel .log > div")).toHaveCount(1);
  await expect(page.locator(".panel .log > div").first()).toHaveText("1. e4");

  // After a move on the puzzle their game is parked rather than lost, and the
  // compact row carries the same offer for the rest of the session.
  await page.locator(".panel").getByRole("button", { name: "Puzzle of the day" }).click();
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();
  // The day it is for is said in one place, so it has to survive the move that
  // hands the autosave over — and it stays one banner, not a banner and the
  // compact row under it.
  await expect(page.locator(".link-banner")).toHaveText(/Puzzle of 1 August 2026 \(UTC\)/);
  await expect(page.locator(".parked-game-row")).toHaveCount(0);
  await page.getByRole("button", { name: /Back to my game/ }).click();
  await expect(page.locator(".panel .log > div")).toHaveCount(1);
  await expect(page.locator(".panel .log > div").first()).toHaveText("1. e4");
});

test("no takeback and no play-from-here while a puzzle is on the board", async ({ page }) => {
  await stubCollector(page, ROW);
  // With a game of their own to go back to: nothing is parked for a player who
  // never had one, so the way out at the end would be New Game instead.
  await open(page, "./?daily", { [SAVE_KEY]: ownGameSave() });
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");

  // Unlimited undo is not a puzzle: with it the failure state is unreachable
  // and "Try again" is decoration. The slot stays occupied so the row keeps its
  // widths and nothing moves under the thumb.
  await expect(page.locator(".takeback-btn")).toHaveCount(0);
  await expect(page.locator(".action-slot-empty")).toHaveCount(1);
  await expect(page.locator(".browse-step-btn")).toHaveCount(2);

  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();
  // Browsing stays available — it changes which ply is on screen, never the
  // game — and even there the fork is withheld.
  await page.locator('[aria-label="Previous move"]').click();
  await expect(page.locator(".play-here-btn")).toHaveCount(0);
  await expect(page.locator(".action-slot-empty")).toHaveCount(1);
  await page.locator(".back-btn").click();

  await page.getByRole("button", { name: /Back to my game/ }).click();
  await expect(page.locator(".takeback-btn")).toBeVisible();
});

test("back to my game takes the banner with it", async ({ page }) => {
  await stubCollector(page, ROW);
  await open(page, "./?daily", { [SAVE_KEY]: ownGameSave() });
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");

  // Fail it, so there is a banner to outlive the position it describes.
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();
  await expect(page.locator(".panel .log .log-move")).toHaveCount(2);
  await page.locator('[data-square="f1"]').click();
  await page.locator('[data-square="g1"]').click();
  await expect(page.locator(".puzzle-overlay")).toHaveText(/Not mate in 2\./);

  await page.getByRole("button", { name: /Back to my game/ }).click();
  await expect(page.locator(".puzzle-overlay")).toHaveCount(0);
  await expect(page.locator(".link-banner")).toHaveCount(0);
  // Their own game, one move deep, with the board taking moves again: the
  // lockout belonged to the attempt.
  await expect(page.locator(".panel .log > div").first()).toHaveText("1. e4");
  await expect(page.locator(".takeback-btn")).toBeVisible();
});

test("a line that runs out of moves fails, and Try again starts it over", async ({ page }) => {
  const collector = await stubCollector(page, ROW);
  await open(page, "./?daily");
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");

  // Two king shuffles: the mate is Bb8=R#, so this uses the attempt up without
  // ever threatening it.
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();
  await expect(page.locator('[data-square="f1"] img, [data-square="f1"] svg')).toBeVisible();
  // The label is the solver's colour and it holds still while the engine
  // answers, rather than telling them Black is to play and to mate in 2. Read
  // once rather than polled: the point is what it says at this instant, and the
  // underline having gone to "thinking" is what says the move landed.
  await expect(page.locator(".board-status-underline.thinking")).toBeVisible();
  expect(await page.locator(".board-status").textContent()).toBe("White to play, mate in 2");
  // Two plies means the engine has replied, so it is the solver's move again.
  // The status line cannot say: it is the puzzle's label and it holds still.
  await expect(page.locator(".panel .log .log-move")).toHaveCount(2);
  await page.locator('[data-square="f1"]').click();
  await page.locator('[data-square="g1"]').click();

  await expect(page.locator(".puzzle-overlay")).toHaveText(/Not mate in 2\./);
  const failed = await eventsNamed(page, collector, "puzzle_failed");
  expect(failed).toHaveLength(1);
  expect(failed[0].props).toMatchObject({ date: "2026-08-01", mate_in: 2, attempts: 1 });
  expect(collector.events.some((e) => e.name === "puzzle_solved")).toBe(false);

  // A failed attempt ends the attempt: the engine does not reply, and the board
  // stops taking moves rather than leaving the player playing on under a banner
  // saying it is over.
  const plies = await page.locator(".panel .log > div").count();
  await page.waitForTimeout(1500);
  await expect(page.locator(".panel .log > div")).toHaveCount(plies);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".puzzle-overlay")).toHaveCount(0);
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
  await expect(page.locator(".panel .log > div")).toHaveCount(0);
  // Unlimited retries, and each one is its own attempt.
  const opens = await eventsNamed(page, collector, "puzzle_open");
  expect(opens).toHaveLength(2);
  expect(opens[1].props).toMatchObject({ date: "2026-08-01", attempts: 2 });
});

test("a retry does not park itself over the player's own game", async ({ page }) => {
  await stubCollector(page, ROW);
  await open(page, "./", { [SAVE_KEY]: ownGameSave() });
  await page.locator(".panel").getByRole("button", { name: "Puzzle of the day" }).click();

  // The first move parks their own game and hands the autosave to the puzzle,
  // so from here on the autosave is the attempt rather than their game.
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();
  await expect(page.locator(".panel .log .log-move")).toHaveCount(2);
  await page.locator('[data-square="f1"]').click();
  await page.locator('[data-square="g1"]').click();
  await expect(page.locator(".puzzle-overlay")).toHaveText(/Not mate in 2\./);

  await page.getByRole("button", { name: "Try again" }).click();
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();

  // The second attempt's first move must not park the first attempt: the parked
  // slot is where their own game is, and there is nowhere else it survives.
  await page.getByRole("button", { name: /Back to my game/ }).click();
  await expect(page.locator(".panel .log > div")).toHaveCount(1);
  await expect(page.locator(".panel .log > div").first()).toHaveText("1. e4");
});

test("the rules summary is reachable from the settings sheet on a phone", async ({ page }) => {
  await stubCollector(page, ROW);
  await open(page, "./");
  await page.setViewportSize({ width: 320, height: 720 });

  await page.locator(".mobile-bar").getByRole("button", { name: "Settings" }).click();
  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Rules summary" })).toBeVisible();
  await expect(sheet).toContainText("Castle shall you not.");
});

test("New Game leaves the puzzle, and the banner with it", async ({ page }) => {
  await stubCollector(page, ROW);
  await open(page, "./?daily");
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");

  // Fail it, so there is a banner to outlive the position it describes.
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="f1"]').click();
  await expect(page.locator(".panel .log .log-move")).toHaveCount(2);
  await page.locator('[data-square="f1"]').click();
  await page.locator('[data-square="g1"]').click();
  await expect(page.locator(".puzzle-overlay")).toHaveText(/Not mate in 2\./);

  // New Game is where the mode is picked now, so it always opens the dialog,
  // and the warning about the moves it discards shares it.
  await page.locator(".action-picker .new-game-btn").click();
  await expect(page.locator(".modal")).toContainText("Discard the game?");
  await page.getByRole("button", { name: "Computer" }).click();

  await expect(page.locator(".puzzle-overlay")).toHaveCount(0);
  await expect(page.locator(".board-status")).toHaveText("White to move.");
  await expect(page.locator(".link-banner")).toHaveCount(0);
  // Out of the puzzle entirely: the board takes moves again and the takeback is
  // back, and the entry point is still there to go round once more.
  await expect(page.locator(".takeback-btn")).toBeVisible();
  await expect(page.locator(".panel").getByRole("button", { name: "Puzzle of the day" })).toBeVisible();
});

test("no puzzle entry point while a live match is on the board", async ({ page }) => {
  // The match owns the position: a puzzle loaded over it would take the
  // opponent's polled moves, which is an illegal move alert on their every ply.
  await stubCollector(page, ROW);
  await stubMatch(page);
  await open(page, "./?lm=m1");
  await expect(page.getByRole("button", { name: "Play as Black" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Puzzle of the day" })).toHaveCount(0);

  // New Game is the way out of a match, and the entry point comes back with it.
  await page.locator(".action-picker .new-game-btn").click();
  await page.getByRole("button", { name: "Computer" }).click();
  await expect(page.locator(".panel").getByRole("button", { name: "Puzzle of the day" })).toBeVisible();
});

test("`?lm=` beats `?daily`, whichever response lands first", async ({ page }) => {
  const collector = await stubCollector(page, ROW);
  await stubMatch(page);
  await open(page, "./?daily&lm=m1");

  // The match takes the board when its fetch lands, and the puzzle never
  // claims it, whichever of the two responses is first.
  await expect(page.getByRole("button", { name: "Play as Black" })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByRole("button", { name: "Play as Black" })).toBeVisible();
  await expect(page.locator(".puzzle-overlay")).toHaveCount(0);
  expect(collector.events.some((e) => e.name === "puzzle_open")).toBe(false);
});

test("a day-stale cached puzzle is replaced by today's when the response lands", async ({ page }) => {
  // Yesterday's row, told apart from today's on sight: a different position, a
  // different length, a different date.
  const YESTERDAY = { publish_date: "2026-07-31", param: LINK_PARAM, mate_in: 3 };

  await stubCollector(page, YESTERDAY);
  await open(page, "./");
  // One load with no `?daily`, purely to fill the cache.
  await expect(page.getByRole("button", { name: "Puzzle of the day" })).toBeVisible();

  // Today's row, held back long enough that the cache is demonstrably what
  // `?daily` had to go on.
  await page.unrouteAll();
  const opens: string[] = [];
  await page.route("**/rest/v1/puzzles*", async (route: Route) => {
    await new Promise((r) => setTimeout(r, 1200));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([ROW]),
    });
  });
  await page.route("**/rest/v1/events", (route: Route) => {
    const body = route.request().postDataJSON();
    if (body.name === "puzzle_open") opens.push(String(body.props.date));
    return route.fulfill({ status: 201, body: "" });
  });
  await page.route("**/rest/v1/games", (route: Route) => route.fulfill({ status: 201, body: "" }));

  await open(page, "./?daily");
  // The cache is what is on the board first — an old puzzle, not a wrong one.
  await expect(page.locator(".board-status")).toHaveText("Black to play, mate in 3");
  await expect(page.locator(".link-banner")).toHaveText(/Puzzle of 31 July 2026 \(UTC\)/);

  // …and today's takes it the moment it arrives, since nothing has been played
  // on the stale one and today's is what the player asked for.
  await expect(page.locator(".board-status")).toHaveText("White to play, mate in 2");
  await expect(page.locator(".link-banner")).toHaveText(/Puzzle of 1 August 2026 \(UTC\)/);
  await expect.poll(() => opens).toEqual(["2026-07-31", "2026-08-01"]);
});
