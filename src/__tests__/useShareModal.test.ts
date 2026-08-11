/**
 * The sharer's side of a history link: which cursor the dialog encodes, and
 * when it falls back to a position-only link (share-links-spec.md §4.4).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { Square } from "chess.js";
import { EvoChessGame } from "../evochess/game";
import { decodeShareLink, readShareParam } from "../evochess/shareLink";
import { useShareModal } from "../hooks/useShareModal";
import type { GameMeta } from "../telemetry";

/** Only the uid is read, to tag the share events. */
const metaRef = { current: { uid: "test-game" } } as RefObject<GameMeta>;

function push(game: EvoChessGame, uci: string, options = {}) {
  game.applyMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, options);
}

/** Five plies of `data/games/game1.txt`, one of them a minor promotion. */
function playedGame(): EvoChessGame {
  const game = new EvoChessGame();
  push(game, "e2e4");
  push(game, "g7g5");
  push(game, "d2d4");
  push(game, "b7b6");
  push(game, "g2g3", { minorPromo: "b" });
  return game;
}

/** Opens the dialog and returns the `?p=` value it built, or null when the
 *  link could not be made at all. */
function share(game: EvoChessGame, browsePly: number | null): string | null {
  const gameRef = { current: game } as RefObject<EvoChessGame>;
  const browsePlyRef = { current: browsePly } as RefObject<number | null>;
  const { result } = renderHook(() => useShareModal(gameRef, browsePlyRef, metaRef));
  const event = { currentTarget: { focus() {} } } as unknown as ReactMouseEvent<HTMLButtonElement>;
  act(() => {
    void result.current.handleShare(event, false);
  });
  const modal = result.current.shareModal!;
  expect(modal.problem).toBeNull();
  return readShareParam(new URL(modal.url).search);
}

function decoded(param: string | null) {
  const result = decodeShareLink(param!);
  if (!result.ok) throw new Error(`expected a decode, got ${result.code}`);
  return result;
}

describe("useShareModal: the history cursor", () => {
  beforeEach(() => {
    // `buildShareUrl` builds on top of the page's own URL.
    window.history.replaceState(null, "", "/");
  });

  it("encodes the live ply when the player is not browsing", () => {
    const game = playedGame();
    const result = decoded(share(game, null));
    expect(result.cursor).toBe(5);
    expect(result.snapshots).toHaveLength(6);
    expect(result.game.chess.fen()).toBe(game.chess.fen());
  });

  it("encodes the browsed ply, and still sends the whole line", () => {
    const game = playedGame();
    const result = decoded(share(game, 3));
    expect(result.cursor).toBe(3);
    // The line is not cut at the cursor: the recipient can scroll forward.
    expect(result.snapshots).toHaveLength(6);
    expect(result.game.chess.fen()).toBe(game.chess.fen());
  });

  it("puts every ply of the line where the sharer's own history has it", () => {
    const game = new EvoChessGame();
    const own: EvoChessGame[] = [game.copy()];
    for (const [uci, options] of [
      ["e2e4", {}],
      ["g7g5", {}],
      ["d2d4", {}],
      ["b7b6", {}],
      ["g2g3", { minorPromo: "b" }],
    ] as Array<[string, object]>) {
      push(game, uci, options);
      own.push(game.copy());
    }
    for (let cursor = 0; cursor <= 5; cursor++) {
      const result = decoded(share(game, cursor === 5 ? null : cursor));
      expect(result.cursor).toBe(cursor);
      expect(result.snapshots![cursor].chess.fen()).toBe(own[cursor].chess.fen());
      expect(result.snapshots![cursor].moveTokens).toEqual(own[cursor].moveTokens);
    }
  });

  it("clamps a cursor past the end of the line", () => {
    const game = playedGame();
    expect(decoded(share(game, 99)).cursor).toBe(5);
  });

  it("falls back to a position-only link when the start is unknown", () => {
    const game = playedGame();
    game.base = undefined;
    const result = decoded(share(game, 2));
    expect(result.snapshots).toBeUndefined();
    expect(result.cursor).toBeUndefined();
    expect(result.game.chess.fen()).toBe(game.chess.fen());
  });

  it("falls back to a position-only link before the first move", () => {
    const result = decoded(share(new EvoChessGame(), null));
    expect(result.snapshots).toBeUndefined();
  });

  it("falls back to a position-only link when the line will not fit", () => {
    const game = playedGame();
    // Well past MAX_SHARE_PARAM_CHARS at roughly 15 bits a ply. The tokens are
    // never replayed by the encoder, only parsed, so they need not be legal.
    game.moveTokens = Array.from({ length: 3000 }, () => "e2e4");
    const result = decoded(share(game, null));
    expect(result.snapshots).toBeUndefined();
    expect(result.game.chess.fen()).toBe(game.chess.fen());
  });

  it("keeps the history when re-sharing a game that arrived on a history link", () => {
    const first = decoded(share(playedGame(), 2));
    // What App puts on the board: the end of the line, carrying the base.
    const received = first.game.copy();
    const again = decoded(share(received, null));
    expect(again.cursor).toBe(5);
    expect(again.snapshots).toHaveLength(6);
    expect(again.game.chess.fen()).toBe(received.chess.fen());
  });

  it("reports a problem rather than throwing when nothing can be encoded", () => {
    const game = playedGame();
    game.base = undefined;
    // The halfmove clock gets 7 bits, so 200 is past what the format can hold.
    game.chess.load("4k3/8/8/8/8/8/8/4K3 w - - 200 101", { skipValidation: true });
    const gameRef = { current: game } as RefObject<EvoChessGame>;
    const browsePlyRef = createRef<number | null>() as RefObject<number | null>;
    browsePlyRef.current = null;
    const { result } = renderHook(() => useShareModal(gameRef, browsePlyRef, metaRef));
    const event = { currentTarget: { focus() {} } } as unknown as ReactMouseEvent<HTMLButtonElement>;
    act(() => {
      void result.current.handleShare(event, false);
    });
    expect(result.current.shareModal!.problem).toBe("unencodable");
  });
});
