/**
 * The fetch and the solved/failed rule.
 *
 * The URL assertion is the important one: the client never sends a date, and
 * the server-side policy that caps the result at today is the whole security
 * model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cachePuzzle,
  cachePuzzleList,
  countAttempt,
  fetchPuzzles,
  formatPuzzleDate,
  formatPuzzleDateShort,
  HISTORY_LIMIT,
  loadCachedPuzzle,
  loadCachedPuzzleList,
  loadPuzzleOutcomes,
  loadPuzzleSeen,
  markPuzzleSeen,
  puzzleOutcome,
  recordPuzzleOutcome,
  resolvePuzzle,
} from "../dailyPuzzle";

const CACHE_KEY = "evochess-puzzle-v1";
const OUTCOMES_KEY = "evochess-puzzle-outcomes-v1";

const URL_BASE = "https://collector.example";
const KEY = "anon-key";

const ROW = { publish_date: "2026-08-01", param: "AQABBB", mate_in: 2 };
const OLDER = { publish_date: "2026-07-31", param: "AQABCC", mate_in: 3 };

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

describe("fetchPuzzles", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_TELEMETRY_URL", URL_BASE);
    vi.stubEnv("VITE_TELEMETRY_KEY", KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns well-formed rows, newest first", async () => {
    stubFetch([ROW, OLDER]);
    expect(await fetchPuzzles()).toEqual([
      { date: "2026-08-01", param: "AQABBB", mateIn: 2 },
      { date: "2026-07-31", param: "AQABCC", mateIn: 3 },
    ]);
  });

  it("asks for the history in one request and sends no date", async () => {
    const fn = stubFetch([ROW]);
    await fetchPuzzles();
    const [url, options] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `${URL_BASE}/rest/v1/puzzles?select=publish_date,param,mate_in&order=publish_date.desc&limit=${HISTORY_LIMIT}`
    );
    // Nothing that could name a day: no date, no filter on publish_date beyond
    // the ordering, and no client clock in the request at all. The history is a
    // row count for exactly this reason.
    expect(url).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(url).not.toContain("publish_date=");
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    // A GET with no body, so there is nowhere else a date could hide.
    expect(options.body).toBeUndefined();
  });

  it("asks for one request, not one per day", async () => {
    const fn = stubFetch([ROW, OLDER]);
    await fetchPuzzles();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns empty on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    expect(await fetchPuzzles()).toEqual([]);
  });

  it("returns empty on a non-2xx", async () => {
    stubFetch([ROW], { ok: false, status: 401 });
    expect(await fetchPuzzles()).toEqual([]);
  });

  it("returns empty on an empty array", async () => {
    stubFetch([]);
    expect(await fetchPuzzles()).toEqual([]);
  });

  it("drops a malformed row and keeps the rest", async () => {
    for (const row of [
      {},
      { publish_date: "2026-08-01", param: "", mate_in: 2 },
      { publish_date: "2026-08-01", mate_in: 2 },
      { publish_date: 20260801, param: "AQABBB", mate_in: 2 },
      { publish_date: "2026-08-01", param: "AQABBB", mate_in: "2" },
      null,
    ]) {
      // One bad row must not cost the whole list, which is the difference from
      // the single-row fetch this replaced.
      stubFetch([row, OLDER]);
      expect(await fetchPuzzles()).toEqual([{ date: "2026-07-31", param: "AQABCC", mateIn: 3 }]);
    }
    // Not even an array.
    stubFetch({ message: "permission denied" });
    expect(await fetchPuzzles()).toEqual([]);
  });

  it("returns empty without a request when the env config is missing", async () => {
    const fn = stubFetch([ROW]);
    vi.stubEnv("VITE_TELEMETRY_URL", "");
    expect(await fetchPuzzles()).toEqual([]);
    vi.stubEnv("VITE_TELEMETRY_URL", URL_BASE);
    vi.stubEnv("VITE_TELEMETRY_KEY", "");
    expect(await fetchPuzzles()).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("the cache", () => {
  // An in-memory store, as in telemetry.test.ts: the test environment does not
  // hand one over.
  let store: Record<string, string> = {};
  const localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", localStorage);
    vi.stubEnv("VITE_TELEMETRY_URL", URL_BASE);
    vi.stubEnv("VITE_TELEMETRY_KEY", KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads back what was written", () => {
    cachePuzzle({ date: "2026-08-01", param: "AQABBB", mateIn: 2 });
    expect(loadCachedPuzzle()).toEqual({ date: "2026-08-01", param: "AQABBB", mateIn: 2 });
  });

  it("takes a fetched row, so the next load has the entry point at once", async () => {
    stubFetch([ROW]);
    const rows = await fetchPuzzles();
    cachePuzzle(rows[0]);
    expect(loadCachedPuzzle()).toEqual({ date: "2026-08-01", param: "AQABBB", mateIn: 2 });
  });

  it("reads an absent or malformed entry as no cache, and throws nothing", () => {
    expect(loadCachedPuzzle()).toBeNull();
    localStorage.setItem(CACHE_KEY, "{not json");
    expect(loadCachedPuzzle()).toBeNull();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ date: "2026-08-01" }));
    expect(loadCachedPuzzle()).toBeNull();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ date: 20260801, param: "AQABBB", mateIn: 2 }));
    expect(loadCachedPuzzle()).toBeNull();
    localStorage.setItem(CACHE_KEY, JSON.stringify([]));
    expect(loadCachedPuzzle()).toBeNull();
  });

  it("is left alone by a failed request", async () => {
    cachePuzzle({ date: "2026-07-31", param: "AQABBB", mateIn: 3 });
    stubFetch(null, { ok: false, status: 500 });
    expect(await fetchPuzzles()).toEqual([]);
    // Nothing expires it: a stale entry reads as an old puzzle, not a wrong one.
    expect(loadCachedPuzzle()).toEqual({ date: "2026-07-31", param: "AQABBB", mateIn: 3 });
  });

  it("keeps the history in its own key, so an existing install keeps today's", () => {
    cachePuzzle({ date: "2026-08-01", param: "AQABBB", mateIn: 2 });
    cachePuzzleList([
      { date: "2026-08-01", param: "AQABBB", mateIn: 2 },
      { date: "2026-07-31", param: "AQABCC", mateIn: 3 },
    ]);
    expect(loadCachedPuzzle()).toEqual({ date: "2026-08-01", param: "AQABBB", mateIn: 2 });
    expect(loadCachedPuzzleList()).toHaveLength(2);
  });

  it("reads an absent or malformed history as an empty list", () => {
    expect(loadCachedPuzzleList()).toEqual([]);
    localStorage.setItem("evochess-puzzle-list-v1", "{not json");
    expect(loadCachedPuzzleList()).toEqual([]);
    // An object where a list belongs.
    localStorage.setItem("evochess-puzzle-list-v1", JSON.stringify({ date: "2026-08-01" }));
    expect(loadCachedPuzzleList()).toEqual([]);
    // One bad entry costs that entry, not the list.
    localStorage.setItem(
      "evochess-puzzle-list-v1",
      JSON.stringify([{ date: "2026-08-01" }, { date: "2026-07-31", param: "AQABCC", mateIn: 3 }])
    );
    expect(loadCachedPuzzleList()).toEqual([{ date: "2026-07-31", param: "AQABCC", mateIn: 3 }]);
  });

  it("remembers the last puzzle opened, per date", () => {
    expect(loadPuzzleSeen()).toBeNull();
    markPuzzleSeen("2026-08-01");
    expect(loadPuzzleSeen()).toBe("2026-08-01");
    // A new date is unseen again, which lights the button back up.
    markPuzzleSeen("2026-08-02");
    expect(loadPuzzleSeen()).toBe("2026-08-02");
  });
});

describe("the outcome map", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reads back what was written, per date", () => {
    expect(loadPuzzleOutcomes()).toEqual({});
    recordPuzzleOutcome("2026-08-01", "solved");
    recordPuzzleOutcome("2026-07-31", "failed");
    expect(loadPuzzleOutcomes()).toEqual({ "2026-08-01": "solved", "2026-07-31": "failed" });
  });

  it("hands back the new map, so the caller need not read it again", () => {
    expect(recordPuzzleOutcome("2026-08-01", "failed")).toEqual({ "2026-08-01": "failed" });
  });

  it("never downgrades a solve to a failure", () => {
    recordPuzzleOutcome("2026-08-01", "solved");
    // Retrying a solved puzzle and running out of moves must not take the tick
    // away.
    expect(recordPuzzleOutcome("2026-08-01", "failed")).toEqual({ "2026-08-01": "solved" });
    expect(loadPuzzleOutcomes()).toEqual({ "2026-08-01": "solved" });
  });

  it("does upgrade a failure to a solve", () => {
    recordPuzzleOutcome("2026-08-01", "failed");
    expect(recordPuzzleOutcome("2026-08-01", "solved")).toEqual({ "2026-08-01": "solved" });
  });

  it("keeps the newest 90 dates and no more", () => {
    // 100 consecutive days, oldest first, so the pruning has something to sort.
    for (let i = 0; i < 100; i++) {
      const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      recordPuzzleOutcome(date, "solved");
    }
    const outcomes = loadPuzzleOutcomes();
    const dates = Object.keys(outcomes).sort();
    expect(dates).toHaveLength(90);
    // Day 100 is 2026-04-10, day 11 (the oldest kept) is 2026-01-11.
    expect(dates[0]).toBe("2026-01-11");
    expect(dates[89]).toBe("2026-04-10");
  });

  it("reads an absent or malformed entry as an empty map, and throws nothing", () => {
    expect(loadPuzzleOutcomes()).toEqual({});
    store[OUTCOMES_KEY] = "{not json";
    expect(loadPuzzleOutcomes()).toEqual({});
    store[OUTCOMES_KEY] = JSON.stringify([]);
    expect(loadPuzzleOutcomes()).toEqual({});
    // An unknown value is dropped, the rest survives.
    store[OUTCOMES_KEY] = JSON.stringify({ "2026-08-01": "cheated", "2026-07-31": "solved" });
    expect(loadPuzzleOutcomes()).toEqual({ "2026-07-31": "solved" });
  });
});

describe("formatPuzzleDate", () => {
  it("formats the row's date in UTC", () => {
    expect(formatPuzzleDate("2026-08-01")).toBe("1 August 2026");
    // Just past midnight UTC is still the same day west of Greenwich, which is
    // the whole reason the zone is pinned rather than taken from the browser.
    expect(formatPuzzleDate("2026-01-01")).toBe("1 January 2026");
  });

  it("hands back anything it cannot parse", () => {
    expect(formatPuzzleDate("not-a-date")).toBe("not-a-date");
  });

  it("shortens the month for a list of them, still in UTC", () => {
    expect(formatPuzzleDateShort("2026-08-01")).toBe("1 Aug 2026");
    expect(formatPuzzleDateShort("2026-01-01")).toBe("1 Jan 2026");
    expect(formatPuzzleDateShort("not-a-date")).toBe("not-a-date");
  });
});

describe("countAttempt", () => {
  it("starts at 1", () => {
    expect(countAttempt(null, "2026-08-01")).toEqual({ date: "2026-08-01", count: 1 });
  });

  it("increments on a reload of the same date", () => {
    let attempts = countAttempt(null, "2026-08-01");
    attempts = countAttempt(attempts, "2026-08-01");
    attempts = countAttempt(attempts, "2026-08-01");
    expect(attempts).toEqual({ date: "2026-08-01", count: 3 });
  });

  it("resets when the date changes", () => {
    const attempts = countAttempt({ date: "2026-07-31", count: 4 }, "2026-08-01");
    expect(attempts).toEqual({ date: "2026-08-01", count: 1 });
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
