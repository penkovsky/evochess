/**
 * The startup replay that gives a resumed game its browsing history back.
 * `historyRef` is memory-only, so without this a reload collapses the share
 * cursor to the final ply and the chevrons do nothing.
 */
import { describe, expect, it } from "vitest";
import type { Square } from "chess.js";
import { EvoChessGame, MAX_REPLAY_PLIES, rebuildHistory } from "../game";
import { serializeGame, deserializeGame, type SerializedGame } from "../serialize";

function push(game: EvoChessGame, uci: string, options = {}) {
  game.applyMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, options);
}

/** The moves of `data/games/game1.txt`, which include both kinds of promotion. */
const MOVES: Array<[string, object]> = [
  ["e2e4", {}], ["g7g5", {}], ["d2d4", {}], ["b7b6", {}],
  ["g2g3", { minorPromo: "b" }], ["c7c6", {}], ["g3b8", {}], ["a7a6", {}],
  ["b8c7", {}], ["a6a5", { minorPromo: "b" }], ["c2c3", {}], ["g5g4", {}],
  ["c7b8", { rookPromo: true }],
];

function playedGame(plies = MOVES.length): { game: EvoChessGame; plies: EvoChessGame[] } {
  const game = new EvoChessGame();
  const snapshots = [game.copy()];
  for (const [uci, options] of MOVES.slice(0, plies)) {
    push(game, uci, options);
    snapshots.push(game.copy());
  }
  return { game, plies: snapshots };
}

/** A save's round trip drops nothing the replay depends on, but a rook that
 *  has never moved carries no explicit charge entry, so compare the fields the
 *  position is made of rather than the maps verbatim. */
function fields(s: SerializedGame) {
  return {
    fen: s.fen,
    minorRights: s.minorRights,
    rookRights: s.rookRights,
    pawnMoveProgress: s.pawnMoveProgress,
    minorMoveProgress: s.minorMoveProgress,
    moveLog: s.moveLog,
    moveTokens: s.moveTokens,
    rookLocked: [...(s.rookLocked ?? [])].sort(),
    epEvolved: s.epEvolved ?? null,
  };
}

/** What App does on resume: deserialize the save, then replay it. */
function resume(saved: SerializedGame) {
  const restored = deserializeGame(saved);
  const snapshots = rebuildHistory(restored);
  return {
    history: snapshots ? snapshots.slice(0, -1) : [],
    live: snapshots ? snapshots[snapshots.length - 1] : restored,
  };
}

describe("rebuildHistory", () => {
  it("replays a saved game to a position identical to the save's own", () => {
    const { game } = playedGame();
    const saved = JSON.parse(JSON.stringify(serializeGame(game))) as SerializedGame;
    const { live } = resume(saved);
    expect(fields(serializeGame(live))).toEqual(fields(saved));
    // The point of using the last snapshot rather than the deserialized save:
    // chess.js's own move history comes back with it, so threefold repetition
    // starts counting again on a resumed game.
    expect(live.chess.history()).toHaveLength(MOVES.length);
    expect(deserializeGame(saved).chess.history()).toHaveLength(0);
  });

  it("puts every ply where the live game had it", () => {
    const { game, plies } = playedGame();
    const { history, live } = resume(serializeGame(game));
    expect(history).toHaveLength(MOVES.length);
    for (let i = 0; i < history.length; i++) {
      expect(history[i].chess.fen()).toBe(plies[i].chess.fen());
      expect(history[i].moveTokens).toEqual(plies[i].moveTokens);
    }
    expect(live.chess.fen()).toBe(plies[MOVES.length].chess.fen());
  });

  it("carries the base onto every snapshot, so a resumed game re-shares its history", () => {
    const { game } = playedGame(4);
    const snapshots = rebuildHistory(game)!;
    for (const snapshot of snapshots) expect(snapshot.base).toEqual(game.base);
  });

  it("gives up, without throwing, on a token that will not apply", () => {
    const { game } = playedGame(4);
    const saved = serializeGame(game);
    saved.moveTokens = [...saved.moveTokens!.slice(0, 2), "a1a8"];
    expect(rebuildHistory(deserializeGame(saved))).toBeNull();
    // The save's own position is still what comes back, with no history.
    const { history, live } = resume(saved);
    expect(history).toEqual([]);
    expect(live.chess.fen()).toBe(saved.fen);
  });

  it("gives up on a malformed token", () => {
    const { game } = playedGame(4);
    const saved = serializeGame(game);
    saved.moveTokens = ["??"];
    expect(rebuildHistory(deserializeGame(saved))).toBeNull();
  });

  it("gives up when the start is unknown", () => {
    const { game } = playedGame(4);
    game.base = undefined;
    expect(rebuildHistory(game)).toBeNull();
  });

  it("gives up before the first move", () => {
    expect(rebuildHistory(new EvoChessGame())).toBeNull();
  });

  it("gives up above the ply cap, so a load is never held up by a long game", () => {
    const { game } = playedGame(4);
    game.moveTokens = Array.from({ length: MAX_REPLAY_PLIES + 1 }, () => "e2e4");
    expect(rebuildHistory(game)).toBeNull();
  });
});
