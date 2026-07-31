import { describe, it, expect, beforeEach, vi } from "vitest";
import { EvoChessGame } from "../evochess/game";
import { encodeShareLink, decodeShareLink } from "../evochess/shareLink";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const session = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => session.get(k) ?? null,
  setItem: (k: string, v: string) => void session.set(k, v),
  removeItem: (k: string) => void session.delete(k),
};

const QUEUE_KEY = "evochess-log-queue-v1";

async function importTelemetry() {
  vi.resetModules();
  return import("../telemetry");
}

function finished(uid: string) {
  return {
    meta: {
      uid,
      startFen: "4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1",
      startParam: null,
      activeMs: 90_000,
      lastPlyAt: null,
      lastPlies: 2,
      takebacks: 0,
      started: true,
      logged: false,
    },
    mode: "human-ai" as const,
    level: "zen",
    aiColor: "b",
    fromShared: false,
    outcome: "win" as const,
    moves: ["e4", "e5"],
    moveTokens: ["e2e4", "e7e5"],
  };
}

/** Evolution state, which is exactly the part a FEN cannot carry. */
function gameWithRights(): EvoChessGame {
  const game = new EvoChessGame();
  game.minorRights = { w: 2, b: 0 };
  game.pawnMoveProgress = { w: 1, b: 0 };
  return game;
}

interface Entry {
  qid: string;
  table: string;
  row: Record<string, unknown>;
}

function queued(): Entry[] {
  return JSON.parse(store.get(QUEUE_KEY) ?? "[]");
}

/** Lets the flush finish, so the queue is asserted at rest and not mid-send. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function queuedGameUids(): unknown[] {
  return queued().map((e) => e.row.game_uid);
}

describe("finished-game log", () => {
  beforeEach(() => {
    store.clear();
    session.clear();
    vi.stubEnv("VITE_TELEMETRY_URL", "https://example.test");
    vi.stubEnv("VITE_TELEMETRY_KEY", "anon");
  });

  it("keeps a game that could not be sent, and sends it on the next start", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame, initTelemetry } = await importTelemetry();

    logFinishedGame(finished("a"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(queuedGameUids()).toEqual(["a"]);

    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await vi.waitFor(() => {
      initTelemetry();
      expect(queued()).toEqual([]);
    });
  });

  it("drops a row the server refuses, so one bad game cannot block the rest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame } = await importTelemetry();

    logFinishedGame(finished("a"));
    await vi.waitFor(() => expect(queued()).toEqual([]));

    logFinishedGame(finished("b"));
    await vi.waitFor(() => expect(queued()).toEqual([]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pauses on a rejected key rather than emptying the queue into the bin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame, initTelemetry } = await importTelemetry();

    logFinishedGame(finished("a"));
    logFinishedGame(finished("b"));
    await settle();
    expect(queuedGameUids()).toEqual(["a", "b"]);
    // One refusal stops the flush, so a bad key costs one request, not one per
    // row.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await vi.waitFor(() => {
      initTelemetry();
      expect(queued()).toEqual([]);
    });
  });

  it("keeps a row the server asked us to slow down on", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame, initTelemetry } = await importTelemetry();

    logFinishedGame(finished("a"));
    await settle();
    expect(queuedGameUids()).toEqual(["a"]);

    await vi.waitFor(() => {
      initTelemetry();
      expect(queued()).toEqual([]);
    });
  });

  it("sends nothing when no endpoint is configured", async () => {
    vi.stubEnv("VITE_TELEMETRY_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame } = await importTelemetry();

    logFinishedGame(finished("a"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(QUEUE_KEY)).toBeUndefined();
  });

  it("sends the move log and the position it replays from", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame } = await importTelemetry();

    logFinishedGame({ ...finished("a"), mode: "human-human", moves: ["e4", "e5", "Nf3"] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.moves).toBe("e4 e5 Nf3");
    expect(body.plies).toBe(3);
    expect(body.start_fen).toBe("4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1");
    // No level to report when there is no AI in the game.
    expect(body.level).toBeNull();
    // A game from the opening replays from its FEN alone.
    expect(body.start_param).toBeNull();
  });

  it("sends the share payload for a game opened from a link", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame } = await importTelemetry();

    const game = finished("a");
    const shared = encodeShareLink(gameWithRights());
    logFinishedGame({ ...game, fromShared: true, meta: { ...game.meta, startParam: shared } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The FEN drops the evolution state, so the payload is what makes the log
    // replayable: it has to survive the round trip intact.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.start_param).toBe(shared);
    const back = decodeShareLink(body.start_param);
    expect(back.ok && back.game.minorRights).toEqual({ w: 2, b: 0 });
    expect(back.ok && back.game.pawnMoveProgress).toEqual({ w: 1, b: 0 });
  });

  it("reports engaged time, not the wall clock", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { logFinishedGame } = await importTelemetry();

    const game = finished("a");
    // A month of accrual could not happen, but the column's bound is 24h and a
    // row past it is refused and then dropped.
    logFinishedGame({ ...game, meta: { ...game.meta, activeMs: 30 * 86_400_000 } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.duration_ms).toBe(86_400_000);
  });
});

describe("funnel events", () => {
  beforeEach(() => {
    store.clear();
    session.clear();
    vi.stubEnv("VITE_TELEMETRY_URL", "https://example.test");
    vi.stubEnv("VITE_TELEMETRY_KEY", "anon");
  });

  it("posts to the events table with the ids and props", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { track } = await importTelemetry();

    track("game_end", { outcome: "win", plies: 12 }, "game-1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/rest/v1/events");
    const row = JSON.parse(init.body);
    expect(row.name).toBe("game_end");
    expect(row.game_uid).toBe("game-1");
    expect(row.props).toEqual({ outcome: "win", plies: 12 });
    expect(row.anon_id).toBe(store.get("evochess-anon-v1"));
    expect(row.session_id).toBe(session.get("evochess-session-v1"));
    expect(row.event_uid).toEqual(expect.any(String));
  });

  it("leaves game_uid null for an event that is not about a game", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const { track } = await importTelemetry();

    track("page_load", { from_share: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).game_uid).toBeNull();
  });

  it("shares one queue with the game log, so an offline event is not lost", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { track, logFinishedGame, initTelemetry } = await importTelemetry();

    track("page_load");
    logFinishedGame(finished("a"));
    track("game_end", {}, "a");
    await vi.waitFor(() => expect(queued()).toHaveLength(3));
    expect(queued().map((e) => e.table)).toEqual(["events", "games", "events"]);

    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await vi.waitFor(() => {
      initTelemetry();
      expect(queued()).toEqual([]);
    });
    // Each entry is its own POST, and a game row and its event share a
    // game_uid, so the queue has to identify entries by something else. All
    // three go out, and to their own endpoints.
    expect(fetchMock.mock.calls.slice(-3).map(([url]) => url)).toEqual([
      "https://example.test/rest/v1/events",
      "https://example.test/rest/v1/games",
      "https://example.test/rest/v1/events",
    ]);
  });

  it("sends nothing when the kill switch is set", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    store.set("evochess-log-off", "1");
    const { track } = await importTelemetry();

    track("page_load");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(QUEUE_KEY)).toBeUndefined();
  });

  it("fires a trackOnce key at most once per load, whatever StrictMode does", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201 }));
    const { trackOnce } = await importTelemetry();

    trackOnce("page_load", "page_load", { viewport_w: 390 });
    trackOnce("page_load", "page_load", { viewport_w: 390 });
    await vi.waitFor(() => expect(queued()).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fires a session-once key again in a new tab, but not after a reload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201 }));
    const first = await importTelemetry();

    first.trackSessionOnce("first_move", "first_move");
    first.trackSessionOnce("first_move", "first_move");
    await vi.waitFor(() => expect(queued()).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(1);

    // A reload: fresh module, same sessionStorage.
    const reloaded = await importTelemetry();
    reloaded.trackSessionOnce("first_move", "first_move");
    await vi.waitFor(() => expect(queued()).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(1);

    // A new tab: sessionStorage goes with it.
    session.clear();
    const newTab = await importTelemetry();
    newTab.trackSessionOnce("first_move", "first_move");
    await vi.waitFor(() => expect(queued()).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("measures load to first move from the session, not from the page load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201 }));
    const now = vi.spyOn(Date, "now");
    const t0 = 1_700_000_000_000;

    now.mockReturnValue(t0);
    const first = await importTelemetry();
    first.track("page_load");
    expect(first.msSinceSessionStart()).toBe(0);

    // The session outlives a reload, so the wait before it still counts.
    now.mockReturnValue(t0 + 30_000);
    const reloaded = await importTelemetry();
    reloaded.track("page_load");
    now.mockReturnValue(t0 + 45_000);
    expect(reloaded.msSinceSessionStart()).toBe(45_000);

    now.mockRestore();
  });

  it("reports no elapsed time before the session has started", async () => {
    const { msSinceSessionStart } = await importTelemetry();
    expect(msSinceSessionStart()).toBe(0);
  });
});

describe("engaged time", () => {
  const t0 = 1_700_000_000_000;

  async function meta() {
    const { newGameMeta } = await importTelemetry();
    return newGameMeta("fen");
  }

  it("counts the gap between plies", async () => {
    const { accruePlyTime } = await importTelemetry();
    const m = await meta();

    accruePlyTime(m, 1, t0);
    accruePlyTime(m, 2, t0 + 20_000);
    accruePlyTime(m, 3, t0 + 50_000);

    // The first ply only anchors, so this is 20s + 30s.
    expect(m.activeMs).toBe(50_000);
  });

  it("caps a gap, so a game left open overnight is not a day of play", async () => {
    const { accruePlyTime } = await importTelemetry();
    const m = await meta();

    accruePlyTime(m, 1, t0);
    accruePlyTime(m, 2, t0 + 14 * 3_600_000);

    expect(m.activeMs).toBe(5 * 60_000);
  });

  it("counts nothing across a reload", async () => {
    const { accruePlyTime } = await importTelemetry();
    const m = await meta();

    accruePlyTime(m, 1, t0);
    accruePlyTime(m, 2, t0 + 20_000);
    // What resuming a save does: the anchor goes, the total stays.
    const resumed = { ...m, lastPlyAt: null };
    accruePlyTime(resumed, 3, t0 + 9 * 3_600_000);

    expect(resumed.activeMs).toBe(20_000);
    expect(resumed.lastPlyAt).toBe(t0 + 9 * 3_600_000);
  });

  it("re-anchors on a takeback without adding", async () => {
    const { accruePlyTime } = await importTelemetry();
    const m = await meta();

    accruePlyTime(m, 1, t0);
    accruePlyTime(m, 2, t0 + 20_000);
    accruePlyTime(m, 1, t0 + 25_000);

    expect(m.activeMs).toBe(20_000);
    // The replacement move accrues from the takeback, not from before it.
    accruePlyTime(m, 2, t0 + 35_000);
    expect(m.activeMs).toBe(30_000);
  });

  it("does nothing when the ply count has not moved", async () => {
    const { accruePlyTime } = await importTelemetry();
    const m = await meta();

    accruePlyTime(m, 1, t0);
    accruePlyTime(m, 1, t0 + 60_000);

    expect(m.activeMs).toBe(0);
    expect(m.lastPlyAt).toBe(t0);
  });
});
