/**
 * The fetch and the solved/failed rule.
 *
 * The URL assertion is the important one: the client never sends a date, and
 * the server-side policy that caps the result at today is the whole security
 * model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchDailyPuzzle, puzzleOutcome, resolvePuzzle } from "../dailyPuzzle";

const URL_BASE = "https://collector.example";
const KEY = "anon-key";

const ROW = { publish_date: "2026-08-01", param: "AQABBB", mate_in: 2 };

/** A fetch that answers with one JSON body, and records the call. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("fetchDailyPuzzle", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_TELEMETRY_URL", URL_BASE);
    vi.stubEnv("VITE_TELEMETRY_KEY", KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a well-formed row", async () => {
    stubFetch([ROW]);
    expect(await fetchDailyPuzzle()).toEqual({
      date: "2026-08-01",
      param: "AQABBB",
      mateIn: 2,
    });
  });

  it("asks for the newest row and sends no date", async () => {
    const fn = stubFetch([ROW]);
    await fetchDailyPuzzle();
    const [url, options] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `${URL_BASE}/rest/v1/puzzles?select=publish_date,param,mate_in&order=publish_date.desc&limit=1`
    );
    // Nothing that could name a day: no date, no filter on publish_date beyond
    // the ordering, and no client clock in the request at all.
    expect(url).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(url).not.toContain("publish_date=");
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    // A GET with no body, so there is nowhere else a date could hide.
    expect(options.body).toBeUndefined();
  });

  it("returns null on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    expect(await fetchDailyPuzzle()).toBeNull();
  });

  it("returns null on a non-2xx", async () => {
    stubFetch([ROW], { ok: false, status: 401 });
    expect(await fetchDailyPuzzle()).toBeNull();
  });

  it("returns null on an empty array", async () => {
    stubFetch([]);
    expect(await fetchDailyPuzzle()).toBeNull();
  });

  it("returns null on a malformed row", async () => {
    for (const row of [
      {},
      { publish_date: "2026-08-01", param: "", mate_in: 2 },
      { publish_date: "2026-08-01", mate_in: 2 },
      { publish_date: 20260801, param: "AQABBB", mate_in: 2 },
      { publish_date: "2026-08-01", param: "AQABBB", mate_in: "2" },
      null,
    ]) {
      stubFetch([row]);
      expect(await fetchDailyPuzzle()).toBeNull();
    }
    // Not even an array.
    stubFetch({ message: "permission denied" });
    expect(await fetchDailyPuzzle()).toBeNull();
  });

  it("returns null without a request when the env config is missing", async () => {
    const fn = stubFetch([ROW]);
    vi.stubEnv("VITE_TELEMETRY_URL", "");
    expect(await fetchDailyPuzzle()).toBeNull();
    vi.stubEnv("VITE_TELEMETRY_URL", URL_BASE);
    vi.stubEnv("VITE_TELEMETRY_KEY", "");
    expect(await fetchDailyPuzzle()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("puzzleOutcome", () => {
  // The solver is White, the engine Black, and the puzzle starts from ply 0.
  const base = {
    gameOver: false,
    isCheckmate: false,
    turn: "w" as const,
    humanColor: "w" as const,
    plies: 0,
    startPly: 0,
    mateIn: 2,
  };

  it("is unresolved partway through", () => {
    // The solver's first move, then the reply: still one move to find.
    expect(puzzleOutcome({ ...base, plies: 1, turn: "b" })).toBeNull();
    expect(puzzleOutcome({ ...base, plies: 2, turn: "w" })).toBeNull();
  });

  it("calls mate on the second move of a mate-in-2 solved, not failed", () => {
    // Ply 3 is the solver's second move, and it is mate. The ply count has
    // reached the failure threshold on this very move, so the checkmate test
    // has to win — this is the off-by-one the whole rule exists for.
    expect(
      puzzleOutcome({ ...base, plies: 3, turn: "b", gameOver: true, isCheckmate: true })
    ).toBe("solved");
  });

  it("fails after mateIn moves without mate", () => {
    expect(puzzleOutcome({ ...base, plies: 3, turn: "b" })).toBe("failed");
    // And a mate-in-3 is not failed at the same ply.
    expect(puzzleOutcome({ ...base, plies: 3, turn: "b", mateIn: 3 })).toBeNull();
    expect(puzzleOutcome({ ...base, plies: 5, turn: "b", mateIn: 3 })).toBe("failed");
  });

  it("fails when the solver is mated", () => {
    expect(
      puzzleOutcome({ ...base, plies: 2, turn: "w", gameOver: true, isCheckmate: true })
    ).toBe("failed");
  });

  it("fails on stalemate and on any other draw", () => {
    expect(puzzleOutcome({ ...base, plies: 2, turn: "w", gameOver: true })).toBe("failed");
    expect(puzzleOutcome({ ...base, plies: 1, turn: "b", gameOver: true })).toBe("failed");
  });

  it("does not fail a shorter mate delivered early", () => {
    // Mate on the solver's first move of a mate-in-2: solved, and the ply count
    // never gets the chance to say otherwise.
    expect(
      puzzleOutcome({ ...base, plies: 1, turn: "b", gameOver: true, isCheckmate: true })
    ).toBe("solved");
  });

  it("counts from startPly, not from ply zero", () => {
    // A puzzle whose position arrives with a move log already in it.
    expect(puzzleOutcome({ ...base, startPly: 10, plies: 12 })).toBeNull();
    expect(puzzleOutcome({ ...base, startPly: 10, plies: 13 })).toBe("failed");
  });
});

describe("resolvePuzzle", () => {
  const puzzle = () => ({ date: "2026-08-01", mateIn: 2, startPly: 0, resolved: false });
  const position = { gameOver: false, isCheckmate: false, turn: "b" as const, humanColor: "w" as const, plies: 3 };

  it("reports the outcome once and never again", () => {
    const state = puzzle();
    expect(resolvePuzzle(state, position)).toBe("failed");
    expect(state.resolved).toBe(true);
    // A takeback walks the ply count back and forward again. The guard, not the
    // arithmetic, is what stops the second event.
    expect(resolvePuzzle(state, { ...position, plies: 1 })).toBeNull();
    expect(resolvePuzzle(state, position)).toBeNull();
    expect(resolvePuzzle(state, { ...position, gameOver: true, isCheckmate: true })).toBeNull();
  });

  it("leaves an unresolved attempt open", () => {
    const state = puzzle();
    expect(resolvePuzzle(state, { ...position, plies: 1 })).toBeNull();
    expect(state.resolved).toBe(false);
    expect(resolvePuzzle(state, { ...position, gameOver: true, isCheckmate: true })).toBe("solved");
  });
});
