/**
 * The reporting rules that used to live inside effects in `App.tsx`, and so had
 * no tests of their own. The e2e suite covers the events reaching the
 * collector; these cover what they say.
 */
import { describe, expect, it } from "vitest";
import { finishedOutcome, gameFinished, humanSeat, shouldReportAbandon } from "../gameOutcome";

describe("humanSeat", () => {
  it("is the seat held, in a match", () => {
    // The seat wins over everything: in a match the human is not White by
    // default, and `aiColor` is stale setup state there.
    expect(humanSeat({ liveSeat: "b", mode: "human-ai", aiColor: "b" })).toBe("b");
    expect(humanSeat({ liveSeat: "w", mode: "human-human", aiColor: "w" })).toBe("w");
  });

  it("is the other side from the engine, against the AI", () => {
    expect(humanSeat({ liveSeat: null, mode: "human-ai", aiColor: "w" })).toBe("b");
    expect(humanSeat({ liveSeat: null, mode: "human-ai", aiColor: "b" })).toBe("w");
  });

  it("stands in as White over the board, where there is no away side", () => {
    expect(humanSeat({ liveSeat: null, mode: "human-human", aiColor: "b" })).toBe("w");
  });
});

describe("gameFinished", () => {
  const none = { isGameOver: false, timeUp: null, liveOutcome: null };

  it("is false while the game is still on", () => {
    expect(gameFinished(none)).toBe(false);
  });

  it("is true when the board says so", () => {
    expect(gameFinished({ ...none, isGameOver: true })).toBe(true);
  });

  it("is true on a flag, and on a live result the board does not show", () => {
    // Both end the game without the position changing. Left out, either would
    // go unreported and then be logged as abandoned on the way out of the tab.
    expect(gameFinished({ ...none, timeUp: "w" })).toBe(true);
    expect(gameFinished({ ...none, liveOutcome: "d" })).toBe(true);
    expect(gameFinished({ ...none, liveOutcome: "b" })).toBe(true);
  });
});

describe("finishedOutcome", () => {
  const base = {
    timeUp: null,
    liveOutcome: null,
    isCheckmate: true,
    turn: "b" as const,
    humanColor: "w" as const,
  };

  it("reads a mate from the side to move, which is the side mated", () => {
    expect(finishedOutcome(base)).toBe("win");
    expect(finishedOutcome({ ...base, turn: "w" })).toBe("loss");
  });

  it("calls anything over that is not mate a draw", () => {
    // Stalemate, repetition, the fifty-move rule: one bucket.
    expect(finishedOutcome({ ...base, isCheckmate: false })).toBe("draw");
  });

  it("reports a live result the board cannot show", () => {
    expect(finishedOutcome({ ...base, isCheckmate: false, liveOutcome: "w" })).toBe("win");
    expect(finishedOutcome({ ...base, isCheckmate: false, liveOutcome: "b" })).toBe("loss");
    expect(finishedOutcome({ ...base, isCheckmate: false, liveOutcome: "d" })).toBe("draw");
  });

  it("puts the live result above the board, so a resignation is not a draw", () => {
    // The position after a resignation is an ordinary playable one. Reading the
    // board first would call every resignation a draw.
    expect(finishedOutcome({ ...base, isCheckmate: false, liveOutcome: "b" })).toBe("loss");
  });

  it("puts the clock above everything", () => {
    expect(finishedOutcome({ ...base, timeUp: "w" })).toBe("timeout");
    expect(finishedOutcome({ ...base, timeUp: "b", liveOutcome: "w" })).toBe("timeout");
  });

  it("is one bucket for a timeout, whichever side ran out", () => {
    // Only the clock runs in human-vs-human, where there is no human side to
    // state a win or a loss from.
    expect(finishedOutcome({ ...base, timeUp: "w" })).toBe("timeout");
    expect(finishedOutcome({ ...base, timeUp: "b" })).toBe("timeout");
  });
});

describe("shouldReportAbandon", () => {
  const meta = { started: true, logged: false, abandonedAtPly: null };

  it("reports a game the player played and left", () => {
    expect(shouldReportAbandon(meta, 7)).toBe(true);
  });

  it("says nothing about a game that never started", () => {
    expect(shouldReportAbandon({ ...meta, started: false }, 7)).toBe(false);
  });

  it("says nothing about a game already reported as finished", () => {
    // The `game_end` effect got there first, so this would be a second row for
    // one game.
    expect(shouldReportAbandon({ ...meta, logged: true }, 7)).toBe(false);
  });

  it("does not report the same position twice", () => {
    // `pagehide` fires again after a bfcache restore. A game reopened and left
    // alone would otherwise be reported once per visit.
    expect(shouldReportAbandon({ ...meta, abandonedAtPly: 7 }, 7)).toBe(false);
  });

  it("does report again once the player has moved on", () => {
    // Same game, further along: a real second abandon, not a repeat of the
    // first.
    expect(shouldReportAbandon({ ...meta, abandonedAtPly: 7 }, 9)).toBe(true);
  });

  it("reports at ply zero, which is not the same as never abandoned", () => {
    // The bfcache guard is a ply number, so `0` and `null` must not be
    // conflated: a game abandoned at the opening is still an abandon.
    expect(shouldReportAbandon(meta, 0)).toBe(true);
    expect(shouldReportAbandon({ ...meta, abandonedAtPly: 0 }, 0)).toBe(false);
  });
});
