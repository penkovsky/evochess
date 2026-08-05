/**
 * The autosave stays restorable, the parameter is dropped only when the shared
 * game becomes live, and an unverified position renders with the engine locked
 * out.
 *
 * The payloads are built by the real encoder rather than pasted in, so this
 * spec cannot drift from the codec the way a copied fixture string could.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Square } from "chess.js";
import { EvoChessGame } from "../src/evochess/game";
import { serializeGame } from "../src/evochess/serialize";
import { encodeShareLink } from "../src/evochess/shareLink";

const TUTORIAL_KEY = "evochess-tutorial-v1";
const SAVE_KEY = "evochess-save-v3";
const SCORES_KEY = "evochess-scores-v1";

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

/** After ply 11 of `data/games/game1.txt`, Black to move. */
const VECTOR_A = encodeShareLink(game1(11));
/** After ply 12 of the same game, White to move, `Bb8=R#` available. */
const VECTOR_B = encodeShareLink(game1(12));

/** A shared position that could not have occurred: Black is in check while
 *  White is to move, so White could simply capture the king. */
function illegalLink(): string {
  const game = new EvoChessGame();
  game.chess.load("4k3/4R3/8/8/8/8/8/4K3 w - - 0 1", { skipValidation: true });
  return encodeShareLink(game);
}

/**
 * The settings half of a save. Every field a save has is required, so a fixture
 * that omits one is discarded on load rather than restored with a hole in it,
 * and the test it was written for would silently exercise the no-save path.
 */
const SAVE_SETTINGS = {
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
} as const;

/** Telemetry meta for a fixture game: a started game that has not been logged. */
function saveMeta(startFen: string) {
  return {
    uid: `e2e-${startFen.slice(0, 8)}`,
    startFen,
    startParam: null,
    activeMs: 0,
    lastPlyAt: null,
    lastPlies: 0,
    takebacks: 0,
    started: true,
    logged: false,
    abandonedAtPly: null,
  };
}

/** An autosave for the recipient's own in-progress game, one move deep. */
function ownGameSave(): string {
  const game = new EvoChessGame();
  game.applyMove("e2", "e4");
  return JSON.stringify({
    ...serializeGame(game),
    ...SAVE_SETTINGS,
    telemetry: saveMeta(new EvoChessGame().chess.fen()),
  });
}

/** The same, but vs the AI on Zen, which is the mode scores are kept for. */
function aiGameSave(): string {
  const save = JSON.parse(ownGameSave());
  return JSON.stringify({ ...save, mode: "human-ai", aiColor: "b", level: "zen" });
}

/** A vs-AI game that is already over: two bare kings, so drawn on sight. */
function drawnGameSave(): string {
  const fen = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
  const game = new EvoChessGame();
  game.chess.load(fen, { skipValidation: true });
  return JSON.stringify({
    ...serializeGame(game),
    ...SAVE_SETTINGS,
    mode: "human-ai",
    // Already scored and already sent, which is what a finished save on disk
    // means: the effects must not record or log it again on this reload.
    telemetry: { ...saveMeta(fen), logged: true },
  });
}

/**
 * Like `freshGamePage`, but lands on a share link and can seed localStorage
 * first: an autosave for "back to my game", and a score record for the level.
 */
async function openShareLink(page: Page, param: string, seed?: Record<string, string>) {
  await page.addInitScript(
    ([key]) => {
      window.localStorage.setItem(key!, JSON.stringify({ completed: [], seen: true }));
    },
    [TUTORIAL_KEY] as const
  );
  if (seed) {
    // Written through the page rather than from an init script, which would
    // re-seed it on every later navigation and make a reload untestable.
    await page.goto("./");
    await page.evaluate((entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    }, Object.entries(seed));
  }
  await page.goto(`./?p=${param}`);
  await expect(page.locator("[data-column]").first()).toBeVisible();
}

test("opening a shared position lets the recipient play Bb8=R# and see mate", async ({ page }) => {
  await openShareLink(page, VECTOR_B);

  // The recipient always moves first, so loading the link must not
  // start an engine search: White is to move and stays that way.
  await expect(page.locator(".board-status")).toHaveText("White to move.");
  await page.waitForTimeout(1500);
  await expect(page.locator(".log > div")).toHaveCount(0);
  await expect(page.locator(".board-status")).toHaveText("White to move.");

  // The bishop on c7 is the piece the whole vector exists for.
  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();

  // c7 → b8 earns the rook right on that move and may spend it on the same
  // move, so the prompt has to offer the rook.
  const rook = page.locator('.promo-icon[title="Promote moved minor piece → Rook"]');
  await expect(rook).toBeVisible();
  await rook.click();

  await expect(page.locator(".log > div").first()).toHaveText("1. Bb8=R#");
  await expect(page.locator(".board-status")).toHaveText("Checkmate - White wins");
  // The mate exists only after the evolution resolves (rules.txt §5), and the
  // rook arrives with its full charges.
  await expect(page.locator('[data-square="b8"] .rook-charge-badge')).toHaveText("5");
});

test("opening a shared position offers g4, g4=N and g4=B", async ({ page }) => {
  await openShareLink(page, VECTOR_A);

  await expect(page.locator(".board-status")).toHaveText("Black to move.");
  await page.locator('[data-square="g5"]').click();
  await page.locator('[data-square="g4"]').click();

  // Black's pawnMoveProgress is 2, so any Black pawn move earns a minor right
  // and may spend it on that same move. All three continuations must be on
  // offer: this is the earn-and-spend case fixed in 57a2b44.
  await expect(page.locator('.promo-icon[title="Promote moved pawn → Knight"]')).toBeVisible();
  await expect(page.locator('.promo-icon[title="Promote moved pawn → Bishop"]')).toBeVisible();
  const none = page.locator('.promo-icon[title="No promotion"]');
  await expect(none).toBeVisible();
  await none.click();
  await expect(page.locator(".log > div").first()).toContainText("g4");
});

test("closing the optional-promotion dialog cancels the move", async ({ page }) => {
  await openShareLink(page, VECTOR_A);
  const pawn = '[data-square="g5"] img, [data-square="g5"] svg';

  // Escape first. "Skip" is how to play the move unpromoted, so the two ways
  // out of the dialog take the move back instead.
  await page.locator('[data-square="g5"]').click();
  await page.locator('[data-square="g4"]').click();
  await expect(page.locator('.promo-icon[title="No promotion"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".log > div")).toHaveCount(0);
  await expect(page.locator(".board-status")).toHaveText("Black to move.");
  await expect(page.locator(pawn)).toBeVisible();

  // Then the ×, on a dialog reopened by the same move.
  await page.locator('[data-square="g5"]').click();
  await page.locator('[data-square="g4"]').click();
  await page.locator(".modal-close").click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".log > div")).toHaveCount(0);
  await expect(page.locator(pawn)).toBeVisible();

  // And the dragged pawn goes back to g5, rather than sitting where it was
  // dropped: the board's position never changed.
  const a = (await page.locator('[data-square="g5"]').boundingBox())!;
  const b = (await page.locator('[data-square="g4"]').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(pawn)).toBeVisible();
  await expect(page.locator('[data-square="g4"] img, [data-square="g4"] svg')).toHaveCount(0);

  // The cancelled move is still there to play.
  await page.locator('[data-square="g5"]').click();
  await page.locator('[data-square="g4"]').click();
  await page.locator('.promo-icon[title="No promotion"]').click();
  await expect(page.locator(".log > div").first()).toContainText("g4");
});

test("a shared position leaves the recipient's own game saved and restorable", async ({ page }) => {
  const save = ownGameSave();
  await openShareLink(page, VECTOR_B, { [SAVE_KEY]: save });

  // The shared position is on the board...
  await expect(page.locator(".board-status")).toHaveText("White to move.");
  await expect(page.locator('[data-square="c7"] img, [data-square="c7"] svg')).toBeVisible();
  // ...and the recipient's autosave is untouched, byte for byte (spec §6.4).
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBe(save);
  // The parameter stays in the address bar until the shared game goes live,
  // so a reload or a mobile tab restore does not silently drop it (spec §3).
  expect(new URL(page.url()).searchParams.get("p")).toBe(VECTOR_B);

  await page.getByRole("button", { name: "Back to my game" }).click();
  // One move deep, in the recipient's own human-vs-human game.
  await expect(page.locator(".log > div")).toHaveCount(1);
  await expect(page.locator(".log > div").first()).toHaveText("1. e4");
  await expect(page.getByRole("button", { name: "Back to my game" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("p")).toBeNull();
});

test("the shared game becomes live on the recipient's first move", async ({ page }) => {
  await openShareLink(page, VECTOR_B, { [SAVE_KEY]: ownGameSave() });

  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();
  await page.locator('.promo-icon[title="No promotion"]').click();
  await expect(page.locator(".log > div").first()).toHaveText("1. Bb8");

  // The parameter is dropped, since the autosave now holds the shared game and
  // a reload must not put the base position back over the move (spec §6.5).
  expect(new URL(page.url()).searchParams.get("p")).toBeNull();
  const saved = await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
  expect(JSON.parse(saved!).moveLog).toEqual(["Bb8"]);

  // And a reload now resumes the shared game rather than putting the base
  // position back over the move just played.
  await page.reload();
  await expect(page.locator(".log > div").first()).toHaveText("1. Bb8");
});

test("the recipient's own game stays reachable after they move on the shared board", async ({ page }) => {
  await openShareLink(page, VECTOR_B, { [SAVE_KEY]: ownGameSave() });

  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();
  await page.locator('.promo-icon[title="No promotion"]').click();
  await expect(page.locator(".log > div").first()).toHaveText("1. Bb8");

  // The banner is gone, because the position is now just the game being
  // played, but the way back is not: it shrinks to a single button.
  await expect(page.locator(".link-banner")).toHaveCount(0);
  await expect(page.locator(".parked-game-btn")).toBeVisible();

  // Their game was moved aside rather than overwritten, so it is still there
  // after a reload as well.
  await page.reload();
  await expect(page.locator(".log > div").first()).toHaveText("1. Bb8");
  await expect(page.locator(".parked-game-btn")).toBeVisible();

  await page.locator(".parked-game-btn").click();
  await expect(page.locator(".log > div")).toHaveCount(1);
  await expect(page.locator(".log > div").first()).toHaveText("1. e4");
  await expect(page.getByRole("button", { name: "vs Human" })).toHaveClass(/active/);
  // Going back is final: the offer retires and the shared game is discarded.
  await expect(page.locator(".parked-game-btn")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".log > div").first()).toHaveText("1. e4");
  await expect(page.locator(".parked-game-btn")).toHaveCount(0);
});

test("New Game gives up the game a shared link displaced", async ({ page }) => {
  await openShareLink(page, VECTOR_B, { [SAVE_KEY]: ownGameSave() });

  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();
  await page.locator('.promo-icon[title="No promotion"]').click();
  await expect(page.locator(".parked-game-btn")).toBeVisible();

  // New Game is an explicit fresh start, so it clears the parked game too
  // rather than leaving a button that outlives what the player asked for.
  // It discards a game in progress, so it asks first.
  await page.getByRole("button", { name: "New Game" }).click();
  await page.getByRole("button", { name: "Discard and start" }).click();
  await expect(page.locator(".log > div")).toHaveCount(0);
  await expect(page.locator(".parked-game-btn")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".parked-game-btn")).toHaveCount(0);
});

test("a game played from a shared position is not scored", async ({ page }) => {
  const scores = JSON.stringify({ zen: { wins: 3, losses: 1, draws: 0 } });
  await openShareLink(page, VECTOR_B, { [SAVE_KEY]: aiGameSave(), [SCORES_KEY]: scores });

  // vs AI, so an ordinary game ending here would be recorded and the score
  // overlay would cover the board.
  await expect(page.getByRole("button", { name: "vs AI" })).toHaveClass(/active/);

  await page.locator('[data-square="c7"]').click();
  await page.locator('[data-square="b8"]').click();
  await page.locator('.promo-icon[title="Promote moved minor piece → Rook"]').click();
  await expect(page.locator(".board-status")).toHaveText("Checkmate - White wins");

  // The overlay dims in over 2.5s before it reveals the score, so waiting past
  // that is what makes its absence mean anything.
  await page.waitForTimeout(3000);
  await expect(page.locator(".score-overlay")).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SCORES_KEY)).toBe(scores);

  // The flag survives the reload the go-live save just made possible, so the
  // finished game does not start counting on a second visit.
  await page.reload();
  await expect(page.locator(".board-status")).toHaveText("Checkmate - White wins");
  await page.waitForTimeout(3000);
  await expect(page.locator(".score-overlay")).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SCORES_KEY)).toBe(scores);
});

test("the same finished position does show the score when it is not from a link", async ({ page }) => {
  // The control for the test above: without it, an overlay that never appears
  // for any reason would let that assertion pass.
  const scores = JSON.stringify({ zen: { wins: 3, losses: 1, draws: 0 } });
  await page.addInitScript(
    (entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    },
    [
      [TUTORIAL_KEY, JSON.stringify({ completed: [], seen: true })],
      [SAVE_KEY, drawnGameSave()],
      [SCORES_KEY, scores],
    ] as Array<[string, string]>
  );
  await page.goto("./");

  await expect(page.locator(".board-status")).toHaveText("Draw - insufficient material");
  await expect(page.locator(".score-overlay")).toHaveCount(1);
  await expect(page.locator(".score-overlay-text")).toContainText("3");
});

test("an unverified position renders with the engine locked out", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });

  await openShareLink(page, illegalLink());

  // The board is shown: a position someone wants to argue about is worth
  // showing even if it was hand-built (spec §5.2).
  await expect(page.locator('[data-square="e7"] img, [data-square="e7"] svg')).toBeVisible();
  await expect(page.locator(".link-banner.unverified")).toContainText(
    "computer opponent is unavailable"
  );

  // Mode is forced to human-human and vs-AI cannot be selected, so the search
  // never sees the position. The AI level control goes with the mode.
  await expect(page.getByRole("button", { name: "vs Human" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "vs AI" })).toBeDisabled();
  await expect(page.locator(".level-picker")).toHaveCount(0);

  // The reason codes are logged, so a report of "the link is weird" is
  // diagnosable from a screenshot of the console.
  expect(warnings.join("\n")).toContain("SIDE_NOT_TO_MOVE_IN_CHECK");

  // New Game is the way out, and it lets the engine back in.
  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.locator(".link-banner.unverified")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "vs AI" })).toBeEnabled();
});

test("the engine stays locked out after a reload", async ({ page }) => {
  // `engineLockedRef` is memory-only, and this position is a valid FEN that
  // survives the autosave round trip, so without the persisted flag the reload
  // below brings it back with the search re-enabled: a board the bitboard layer
  // must never see (share-links-spec.md §5.2).
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });

  await openShareLink(page, illegalLink());
  await expect(page.getByRole("button", { name: "vs AI" })).toBeDisabled();

  // A move is what makes the shared game the live one, and so what puts the
  // position into the autosave in the first place.
  await page.locator('[data-square="e7"]').click();
  await page.locator('[data-square="e6"]').click();
  await expect(page.locator(".log > div")).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("p")).toBeNull();
  expect(JSON.parse(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY))!.unverified).toBe(true);

  warnings.length = 0;
  await page.reload();

  // Same lockout, same banner, on a page that never saw a `?p=`.
  await expect(page.locator(".link-banner.unverified")).toContainText("computer opponent is unavailable");
  await expect(page.getByRole("button", { name: "vs Human" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "vs AI" })).toBeDisabled();
  await expect(page.locator(".level-picker")).toHaveCount(0);
  expect(warnings.join("\n")).toContain("unverified shared position");

  // And New Game is still the way out.
  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.getByRole("button", { name: "vs AI" })).toBeEnabled();
  await page.reload();
  await expect(page.locator(".link-banner.unverified")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "vs AI" })).toBeEnabled();
});

test("a corrupt link reports the reason and falls back to the autosave", async ({ page }) => {
  const save = ownGameSave();
  // A truncated payload: the CRC exists to tell this apart from a position
  // that is merely nonsense.
  await openShareLink(page, VECTOR_B.slice(0, 20), { [SAVE_KEY]: save });

  await expect(page.locator(".link-banner")).toContainText("This link looks incomplete");
  // Fallen through to the normal startup path, which is to resume the autosave.
  await expect(page.locator(".log > div").first()).toHaveText("1. e4");
  // Their game is still theirs. Not compared byte for byte: the fallback path
  // is the ordinary one, so autosaving has resumed and rewritten the record.
  const resumed = JSON.parse(
    (await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY))!
  );
  expect(resumed.moveLog).toEqual(["e4"]);
  expect(resumed.fen).toBe(JSON.parse(save).fen);
  await expect(page.getByRole("button", { name: "Back to my game" })).toHaveCount(0);
});
