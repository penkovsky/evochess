/**
 * The status line, the orientation, and the flags that gate the board. All of
 * it is branching over state App holds, so it is tested without rendering.
 */
import { describe, expect, it } from "vitest";
import type { Square } from "chess.js";
import { EvoChessGame } from "../evochess/game";
import type { LiveSeat, LiveView } from "../liveMatch";
import { deriveBoardView, type BoardViewInput } from "../boardView";
import { buildSquareStyles } from "../boardStyles";

function push(game: EvoChessGame, uci: string) {
  game.applyMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, {});
}

/** A game with `plies` quiet pawn moves in it, plus the snapshots before each. */
function played(plies: number): { game: EvoChessGame; history: EvoChessGame[] } {
  const moves = ["a2a3", "a7a6", "b2b3", "b7b6", "c2c3", "c7c6"];
  const game = new EvoChessGame();
  const history: EvoChessGame[] = [];
  for (const uci of moves.slice(0, plies)) {
    history.push(game.copy());
    push(game, uci);
  }
  return { game, history };
}

function input(over: Partial<BoardViewInput> = {}): BoardViewInput {
  const { game, history } = played(0);
  return {
    game,
    history,
    browsePly: null,
    mode: "human-ai",
    aiColor: "b",
    level: "easy",
    autoFlip: false,
    aiThinking: false,
    timeUp: null,
    live: null,
    puzzle: null,
    puzzleResult: null,
    fromShared: false,
    hasScoreHistory: false,
    promptOpen: false,
    ...over,
  };
}

const seat = (color: "w" | "b"): LiveSeat => ({
  matchId: "m",
  seat: color,
  token: "t",
  firstMover: "w",
  startPayload: null,
});

const match = (over: Partial<LiveView> = {}): LiveView => ({
  matchId: "m",
  status: "live",
  firstMover: "w",
  startPayload: null,
  joined: true,
  freeSeat: null,
  seat: null,
  ...over,
});

describe("deriveBoardView status", () => {
  it("names the side to move on a live position", () => {
    expect(deriveBoardView(input()).status).toBe("White to move.");
  });

  it("says which ply is on screen while browsing, and calls ply 0 the start", () => {
    const { game, history } = played(4);
    expect(deriveBoardView(input({ game, history, browsePly: 0 })).status).toBe("Start position");
    expect(deriveBoardView(input({ game, history, browsePly: 2 })).status).toBe("Move 2 of 4");
  });

  it("shows the browsed position, and falls back to live for an out-of-range cursor", () => {
    const { game, history } = played(4);
    expect(deriveBoardView(input({ game, history, browsePly: 1 })).displayGame).toBe(history[1]);
    expect(deriveBoardView(input({ game, history, browsePly: 9 })).displayGame).toBe(game);
  });

  it("labels a puzzle by the solver's colour, not by whoever is to move", () => {
    const { game, history } = played(1);
    const puzzle = { date: "2026-08-01", mateIn: 2, startPly: 0, aiColor: "b" as const, resolved: false };
    // Black is to move, but the solver has White, so the line holds still.
    expect(deriveBoardView(input({ game, history, puzzle })).status).toBe("White to play, mate in 2");
  });

  it("drops the puzzle label once the attempt resolves", () => {
    const puzzle = { date: "2026-08-01", mateIn: 2, startPly: 0, aiColor: "b" as const, resolved: true };
    expect(deriveBoardView(input({ puzzle, puzzleResult: "failed" })).status).toBe("White to move.");
  });

  it("reports a flag fall over the position", () => {
    expect(deriveBoardView(input({ mode: "human-human", timeUp: "w" })).status).toBe(
      "White ran out of time. Black wins!"
    );
  });

  it("says what a live match is waiting for", () => {
    // Our seat is Black and White opens, so there is nothing to do until the
    // other side is filled.
    const waiting = input({ mode: "human-human", live: match({ joined: false, seat: seat("b") }) });
    expect(deriveBoardView(waiting).status).toBe("Waiting for your opponent to join.");

    // Our seat is Black, so ply 1 is not ours.
    const theirTurn = input({ mode: "human-human", live: match({ seat: seat("b") }) });
    expect(deriveBoardView(theirTurn).status).toBe("Waiting for your opponent's move.");

    // No token at all: the link only reads.
    const observer = input({ mode: "human-human", live: match() });
    expect(deriveBoardView(observer).status).toBe("Watching. White to move.");
  });
});

describe("deriveBoardView orientation", () => {
  it("puts the human's own pieces at the bottom against the AI", () => {
    expect(deriveBoardView(input({ aiColor: "b" })).boardOrientation).toBe("white");
    expect(deriveBoardView(input({ aiColor: "w" })).boardOrientation).toBe("black");
  });

  it("follows the seat in a live match, whatever the pickers say", () => {
    const view = deriveBoardView(input({ aiColor: "b", live: match({ seat: seat("b") }) }));
    expect(view.boardOrientation).toBe("black");
    expect(view.bottomColor).toBe("b");
    expect(view.topColor).toBe("w");
  });

  it("flips between plies in human-vs-human only when asked to", () => {
    const { game, history } = played(1); // Black to move
    expect(deriveBoardView(input({ game, history, mode: "human-human" })).boardOrientation).toBe("white");
    const flipped = input({ game, history, mode: "human-human", autoFlip: true });
    expect(deriveBoardView(flipped).boardOrientation).toBe("black");
  });
});

describe("deriveBoardView gating", () => {
  it("refuses moves while browsing, and on the AI's turn", () => {
    const { game, history } = played(4);
    expect(deriveBoardView(input({ game, history })).allowDragging).toBe(true);
    expect(deriveBoardView(input({ game, history, browsePly: 2 })).allowDragging).toBe(false);
    // The AI has White here, so the opening position is its turn.
    expect(deriveBoardView(input({ aiColor: "w" })).allowDragging).toBe(false);
  });

  it("refuses moves from a seat that is not ours, and lets taps through anyway", () => {
    const view = deriveBoardView(input({ mode: "human-human", live: match({ seat: seat("b") }) }));
    expect(view.allowDragging).toBe(false);
    // Taps never checked the seat: `attemptMove` is what refuses them.
    expect(view.humanCanMove).toBe(true);
  });

  it("refuses taps while the promotion prompt is open, but not drags", () => {
    const view = deriveBoardView(input({ promptOpen: true }));
    expect(view.humanCanMove).toBe(false);
    expect(view.allowDragging).toBe(true);
  });

  it("refuses both once the puzzle attempt has resolved", () => {
    const view = deriveBoardView(input({ puzzleResult: "failed" }));
    expect(view.humanCanMove).toBe(false);
    expect(view.allowDragging).toBe(false);
  });
});

describe("deriveBoardView score overlay", () => {
  it("wants a finished vs-AI game with a record behind it", () => {
    const base = { mode: "human-ai" as const, timeUp: "w" as const, hasScoreHistory: true };
    expect(deriveBoardView(input(base)).showScoreOverlay).toBe(true);
    // The sharer chose the starting advantage, so the result was never recorded.
    expect(deriveBoardView(input({ ...base, fromShared: true })).showScoreOverlay).toBe(false);
    expect(deriveBoardView(input({ ...base, hasScoreHistory: false })).showScoreOverlay).toBe(false);
    expect(deriveBoardView(input({ ...base, mode: "human-human" })).showScoreOverlay).toBe(false);
  });

  it("belongs to the end of the live game, not to the ply on screen", () => {
    const { game, history } = played(4);
    const base = { game, history, timeUp: "w" as const, hasScoreHistory: true };
    expect(deriveBoardView(input({ ...base, browsePly: 1 })).showScoreOverlay).toBe(false);
  });

  it("titlecases the level for the overlay", () => {
    expect(deriveBoardView(input({ level: "zen" })).levelLabel).toBe("Zen");
  });
});

describe("buildSquareStyles", () => {
  it("is empty when nothing is selected", () => {
    expect(buildSquareStyles(new EvoChessGame(), null)).toEqual({});
  });

  it("marks the selected square and every square it can reach", () => {
    const game = new EvoChessGame();
    const styles = buildSquareStyles(game, "e2" as Square);
    expect(Object.keys(styles).sort()).toEqual(["e2", "e3", "e4"]);
    expect(styles.e2.background).toContain("255, 255, 0");
    // A quiet move is a dot, not a ring.
    expect(styles.e3.background).toContain("19%");
  });
});
