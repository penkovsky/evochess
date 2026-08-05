import { describe, it, expect, beforeEach, vi } from "vitest";
import { EvoChessGame } from "../evochess/game";
import { encodeShareLink } from "../evochess/shareLink";
import {
  clearSeat,
  lmCreate,
  lmFetch,
  lmJoin,
  loadSeat,
  newMatchState,
  readMatchParam,
  replay,
  canMoveNow,
  sanitizeOpts,
  saveSeat,
  seatForPly,
  sendMove,
  shouldPoll,
  type LiveSeat,
  type LiveState,
  type LiveView,
} from "../liveMatch";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const ENV = import.meta.env as Record<string, string>;
ENV.VITE_TELEMETRY_URL = "https://collector.test";
ENV.VITE_TELEMETRY_KEY = "anon-key";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}
function fail(status: number, body = "") {
  return { ok: false, status, json: async () => ({}), text: async () => body } as Response;
}

const seat: LiveSeat = {
  matchId: "m1",
  seat: "w",
  token: "tok",
  firstMover: "w",
  startPayload: null,
};

function view(over: Partial<LiveView> = {}): LiveView {
  return {
    matchId: "m1",
    status: "live",
    firstMover: "w",
    startPayload: null,
    joined: true,
    freeSeat: null,
    seat,
    ...over,
  };
}

beforeEach(() => {
  store.clear();
  vi.restoreAllMocks();
});

describe("turn ownership", () => {
  it("odd plies belong to the first mover, for either colour", () => {
    expect(seatForPly(1, "w")).toBe("w");
    expect(seatForPly(2, "w")).toBe("b");
    expect(seatForPly(3, "w")).toBe("w");
    expect(seatForPly(1, "b")).toBe("b");
    expect(seatForPly(2, "b")).toBe("w");
    expect(seatForPly(3, "b")).toBe("b");
  });
});

describe("sanitizeOpts", () => {
  it("keeps the four known keys and drops everything else", () => {
    expect(
      sanitizeOpts({
        minorPromo: "n",
        rookPromo: true,
        downgradeTo: "b",
        forcedPromo: "q",
        __proto__: { polluted: true },
        takeback: true,
        rookPromoX: "yes",
      })
    ).toEqual({ forcedPromo: "q", minorPromo: "n", rookPromo: true, downgradeTo: "b" });
  });

  it("drops bad values as well as unknown keys", () => {
    expect(sanitizeOpts({ minorPromo: "q", rookPromo: "true", downgradeTo: "r" })).toEqual({});
    expect(sanitizeOpts(null)).toEqual({});
  });
});

describe("replay", () => {
  it("equals playing the moves one by one", () => {
    const byHand = new EvoChessGame();
    byHand.applyMove("e2", "e4");
    byHand.applyMove("e7", "e5");
    byHand.applyMove("d2", "d4");

    const built = replay(null, [
      { ply: 1, from: "e2", to: "e4", opts: {} },
      { ply: 2, from: "e7", to: "e5", opts: {} },
      { ply: 3, from: "d2", to: "d4", opts: {} },
    ]);
    expect(built).not.toBeNull();
    expect(built!.game.chess.fen()).toBe(byHand.chess.fen());
    expect(built!.game.moveLog).toEqual(byHand.moveLog);
    // One snapshot per move: the position before it, which is what
    // `historyRef` holds.
    expect(built!.snapshots).toHaveLength(3);
    expect(built!.snapshots[0].moveLog).toHaveLength(0);
    expect(built!.snapshots[2].moveLog).toHaveLength(2);
  });

  it("replays from a start payload", () => {
    const base = new EvoChessGame();
    base.applyMove("e2", "e4");
    const byHand = base.copy();
    byHand.applyMove("e7", "e5");
    const built = replay(encodeShareLink(base), [{ ply: 1, from: "e7", to: "e5", opts: {} }]);
    expect(built!.game.chess.fen()).toBe(byHand.chess.fen());
  });

  it("is null for a move the engine rejects", () => {
    expect(replay(null, [{ ply: 1, from: "e2", to: "e5", opts: {} }])).toBeNull();
  });
});

describe("newMatchState", () => {
  it("starts a created match with an empty move list, so the first send is ply 1", () => {
    // The creator's board is rebuilt from the payload, exactly as the joiner's
    // is. Keeping the position they created from would make their first send
    // ply N+1, which the server rejects as a gap.
    const base = new EvoChessGame();
    base.applyMove("e2", "e4");
    base.applyMove("e7", "e5");
    const state = newMatchState(encodeShareLink(base), base.turn, "w");
    expect(state.moves).toEqual([]);
    expect(state.freeSeat).toBe("b");
    expect(state.joined).toBe(false);
    const built = replay(state.startPayload, state.moves);
    expect(built!.game.moveLog).toEqual([]);
    expect(built!.snapshots).toEqual([]);
    // Which makes the ply the creator sends for their next move ply 1.
    expect(built!.game.moveLog.length + 1).toBe(1);
    expect(seatForPly(1, state.firstMover)).toBe(state.firstMover);
  });
});

describe("canMoveNow", () => {
  it("lets every move through when there is no match at all", () => {
    expect(canMoveNow(null, 0)).toBe(true);
    expect(canMoveNow(null, 7)).toBe(true);
  });

  it("owns the odd plies to the first mover, and the even ones to the other seat", () => {
    // We hold White, who moves first, so ply 1 is ours and ply 2 is not.
    expect(canMoveNow(view(), 0)).toBe(true);
    expect(canMoveNow(view(), 1)).toBe(false);
    expect(canMoveNow(view(), 2)).toBe(true);
  });

  it("refuses an observer every move, which is the whole read-only rule", () => {
    expect(canMoveNow(view({ seat: null }), 0)).toBe(false);
    expect(canMoveNow(view({ seat: null }), 1)).toBe(false);
  });

  it("refuses everyone once the match is over", () => {
    expect(canMoveNow(view({ status: "over" }), 0)).toBe(false);
  });
});

describe("polling", () => {
  it("is silent on the local turn, while hidden, and once the game is over", () => {
    // Ply 1 is White's, and we hold White.
    expect(shouldPoll(view(), 0, false, false)).toBe(false);
    expect(shouldPoll(view(), 1, false, false)).toBe(true); // the opponent's turn
    expect(shouldPoll(view(), 1, false, true)).toBe(false); // hidden
    expect(shouldPoll(view(), 1, true, false)).toBe(false); // game over
    expect(shouldPoll(view({ status: "over" }), 1, false, false)).toBe(false);
    expect(shouldPoll(null, 1, false, false)).toBe(false);
  });

  it("polls on our own turn while the second seat is still empty", () => {
    expect(shouldPoll(view({ joined: false, freeSeat: "b" }), 0, false, false)).toBe(true);
  });

  it("always polls for an observer", () => {
    expect(shouldPoll(view({ seat: null }), 0, false, false)).toBe(true);
  });
});

describe("transport", () => {
  it("posts to the rpc endpoint with the anon key and returns the seat", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ok({ match_id: "abc", token: "t0" }));
    const created = await lmCreate(null, "w", "b");
    expect(created).toEqual({
      matchId: "abc",
      seat: "b",
      token: "t0",
      firstMover: "w",
      startPayload: null,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://collector.test/rest/v1/rpc/lm_create");
    expect((init.headers as Record<string, string>).apikey).toBe("anon-key");
    expect(JSON.parse(init.body as string)).toEqual({
      p_start_payload: null,
      p_first_mover: "w",
      p_creator_seat: "b",
    });
  });

  it("parses a fetch and allowlists opts off the wire", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({
        status: "live",
        first_mover: "b",
        start_payload: null,
        joined: true,
        free_seat: null,
        moves: [{ ply: 1, from: "e7", to: "e5", opts: { minorPromo: "n", evil: 1 } }],
      })
    );
    const state = await lmFetch("m1", 0);
    expect(state).toEqual({
      status: "live",
      firstMover: "b",
      startPayload: null,
      joined: true,
      freeSeat: null,
      moves: [{ ply: 1, from: "e7", to: "e5", opts: { minorPromo: "n" } }],
    });
  });

  it("returns null for an unknown match, and for a failed read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(null));
    expect(await lmFetch("nope", 0)).toBeNull();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await lmFetch("m1", 0)).toBeNull();
  });

  it("raises when the seat is taken, so the client stays read-only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fail(400));
    const state = { firstMover: "w", startPayload: null } as LiveState;
    await expect(lmJoin("m1", state)).rejects.toThrow();
  });
});

describe("sendMove", () => {
  it("retries a network failure and reports the eventual success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValueOnce(ok(null));
    const slept: number[] = [];
    const done = await sendMove(seat, 1, "e2", "e4", {}, async (ms) => void slept.push(ms));
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([300, 600]); // backoff
  });

  it("does not retry a rejection the server will keep making", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(fail(400));
    expect(await sendMove(seat, 1, "e2", "e4", {}, async () => {})).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("seat store", () => {
  it("hands back a seat only for the match it belongs to", () => {
    saveSeat(seat);
    expect(loadSeat("m1")).toEqual(seat);
    expect(loadSeat("m2")).toBeNull(); // a different match: an observer
    clearSeat();
    expect(loadSeat("m1")).toBeNull();
  });

  it("survives a corrupt record", () => {
    store.set("evochess-live-v1", "{not json");
    expect(loadSeat("m1")).toBeNull();
  });
});

describe("readMatchParam", () => {
  it("reads ?lm= and nothing else", () => {
    expect(readMatchParam("?lm=abc")).toBe("abc");
    expect(readMatchParam("?p=xyz")).toBeNull();
    expect(readMatchParam("?lm=")).toBeNull();
  });
});
