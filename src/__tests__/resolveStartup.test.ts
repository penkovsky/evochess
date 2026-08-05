import { describe, it, expect } from "vitest";
import { EvoChessGame, START_FEN } from "../evochess/game";
import { encodeShareLink } from "../evochess/shareLink";
import type { LoadedGame } from "../evochess/persistence";
import type { DailyPuzzle } from "../evochess/dailyPuzzle";
import type { TutorialProgress } from "../evochess/tutorialProgress";
import { resolveStartup, type StartupInputs } from "../features/startup/resolveStartup";

const savedGame = (overrides: Partial<LoadedGame> = {}): LoadedGame => ({
  game: new EvoChessGame(),
  mode: "human-ai",
  aiColor: "b",
  level: "zen",
  autoFlip: false,
  timerEnabled: false,
  timerMinutes: 5,
  clock: { w: 0, b: 0 },
  ponderEnabled: true,
  fromShared: false,
  unverified: false,
  telemetry: {
    uid: "test-uid",
    startFen: START_FEN,
    startParam: null,
    activeMs: 0,
    lastPlyAt: null,
    lastPlies: 0,
    takebacks: 0,
    started: true,
    logged: false,
    abandonedAtPly: null,
  },
  ...overrides,
});

const puzzleRow: DailyPuzzle = { date: "2026-08-05", mateIn: 2, param: encodeShareLink(new EvoChessGame()) };

const unseen: TutorialProgress = { seen: false, completed: [] };
const seen: TutorialProgress = { seen: true, completed: [] };

/** A `?p=` payload for a real position, so the decode under test is the real one. */
function sharedParam(): string {
  const game = new EvoChessGame();
  game.applyMove("e2", "e4");
  return encodeShareLink(game);
}

const resolve = (opts: Partial<StartupInputs> = {}) =>
  resolveStartup({ search: "", saved: null, cache: null, progress: seen, ...opts });

describe("resolveStartup precedence", () => {
  it("gives the board to a bare load with nothing to show", () => {
    const startup = resolve();
    expect(startup.board).toEqual({ kind: "fresh", offerTutorial: false });
    expect(startup.resumed).toBe(false);
    expect(startup.fromShare).toBe(false);
  });

  it("resumes the autosave when nothing more specific is present", () => {
    const saved = savedGame();
    const startup = resolve({ saved });
    expect(startup.board).toEqual({ kind: "resume", saved });
    expect(startup.resumed).toBe(true);
  });

  it("gives the board to `?p=` over the autosave, which keeps its settings", () => {
    const param = sharedParam();
    const saved = savedGame();
    const startup = resolve({ search: `?p=${param}`, saved });
    expect(startup.board.kind).toBe("shared");
    if (startup.board.kind !== "shared") throw new Error("unreachable");
    expect(startup.board.param).toBe(param);
    expect(startup.board.link.ok).toBe(true);
    // The autosave is left where it is, and is not what the player is looking at.
    expect(startup.settings).toBe(saved);
    expect(startup.resumed).toBe(false);
    expect(startup.fromShare).toBe(true);
    expect(startup.shareRefused).toBe(false);
  });

  it("falls back to the autosave when the link is refused", () => {
    const saved = savedGame();
    const startup = resolve({ search: "?p=not-a-link", saved });
    expect(startup.board).toEqual({ kind: "resume", saved });
    expect(startup.shareRefused).toBe(true);
    expect(startup.fromShare).toBe(true);
    expect(startup.resumed).toBe(true);
    expect(startup.notice).toBeTruthy();
    expect(startup.refusedCode).toBeTruthy();
  });

  it("`?p=` wins over `?daily`, being the more specific", () => {
    const startup = resolve({ search: `?daily&p=${sharedParam()}`, cache: puzzleRow });
    expect(startup.board.kind).toBe("shared");
    expect(startup.daily).toBe(false);
    expect(startup.puzzle).toBeNull();
  });

  it("drops `?daily` even when the link alongside it is refused", () => {
    // `daily` is read off the absence of a `?p=` parameter, not off the decode:
    // a refused link is still someone arriving to look at a position.
    const startup = resolve({ search: "?daily&p=not-a-link", cache: puzzleRow });
    expect(startup.daily).toBe(false);
    expect(startup.puzzle).toBeNull();
  });

  it("leaves the autosave on the board under `?daily`, and hands the cache over", () => {
    const saved = savedGame();
    const startup = resolve({ search: "?daily", saved, cache: puzzleRow });
    expect(startup.board).toEqual({ kind: "resume", saved });
    expect(startup.daily).toBe(true);
    expect(startup.puzzle).toBe(puzzleRow);
  });

  it("asks for a puzzle with no cache to hand over", () => {
    const startup = resolve({ search: "?daily" });
    expect(startup.daily).toBe(true);
    expect(startup.puzzle).toBeNull();
  });

  it("only hands the cache over when `?daily` asked for it", () => {
    const startup = resolve({ cache: puzzleRow });
    expect(startup.daily).toBe(false);
    expect(startup.puzzle).toBeNull();
  });

  it("leaves the autosave on the board under `?lm=`, which is fetched", () => {
    const saved = savedGame();
    const startup = resolve({ search: "?lm=abc123", saved });
    expect(startup.board).toEqual({ kind: "resume", saved });
    expect(startup.match).toBe("abc123");
  });

  it("takes a match id alongside a `?p=` link", () => {
    const startup = resolve({ search: `?lm=abc123&p=${sharedParam()}` });
    expect(startup.board.kind).toBe("shared");
    expect(startup.match).toBe("abc123");
  });
});

describe("resolveStartup tutorial invite", () => {
  it("offers it on a bare first load", () => {
    expect(resolve({ progress: unseen }).board).toEqual({ kind: "fresh", offerTutorial: true });
  });

  it("does not offer it twice", () => {
    expect(resolve({ progress: seen }).board).toEqual({ kind: "fresh", offerTutorial: false });
  });

  it("does not offer it over a puzzle about to arrive", () => {
    expect(resolve({ search: "?daily", progress: unseen }).board).toEqual({ kind: "fresh", offerTutorial: false });
  });

  it("does not offer it over a match about to arrive", () => {
    expect(resolve({ search: "?lm=abc123", progress: unseen }).board).toEqual({
      kind: "fresh",
      offerTutorial: false,
    });
  });

  it("does not offer it on a shared board", () => {
    expect(resolve({ search: `?p=${sharedParam()}`, progress: unseen }).board.kind).toBe("shared");
  });

  it("does not offer it over a resumed game", () => {
    expect(resolve({ saved: savedGame(), progress: unseen }).board.kind).toBe("resume");
  });

  it("offers it when the only link present was refused", () => {
    // Nothing is on the board, so nothing is covered up.
    expect(resolve({ search: "?p=not-a-link", progress: unseen }).board).toEqual({
      kind: "fresh",
      offerTutorial: true,
    });
  });
});
