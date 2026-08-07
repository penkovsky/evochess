/**
 * The live match hook's own behaviour, as opposed to the transport's
 * (`liveMatch.test.ts`). What is here needs the hook because it is about what
 * the player is told, not about what crosses the wire.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { EvoChessGame } from "../evochess/game";
import { useLiveMatch, type ApplyMove } from "../features/live/useLiveMatch";

// This project's jsdom environment provides `window` but not `localStorage`,
// and the hook stores a seat the moment a match is created.
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
/** A 4xx: the call is refused rather than retried, so nothing happened. */
function refused() {
  return { ok: false, status: 400, json: async () => ({}), text: async () => "no" } as Response;
}

/** Routes by function name, so a poll landing mid-test cannot eat an answer. */
function route(handlers: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const fn = url.split("/rpc/")[1];
    const handler = handlers[fn];
    if (!handler) throw new Error(`unexpected call to ${fn}`);
    return handler();
  });
}

function mount(fetchMock: ReturnType<typeof route>) {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const setLinkNotice = vi.fn();
  const args = {
    gameRef: { current: new EvoChessGame() } as RefObject<EvoChessGame>,
    historyRef: { current: [] } as RefObject<EvoChessGame[]>,
    clockRef: { current: { w: 0, b: 0 } },
    clockHistoryRef: { current: [] },
    rerender: () => {},
    adoptPosition: () => {},
    savedGameRef: { current: null },
    setLinkNotice,
    setSetupMode: () => {},
    clearPrompts: () => {},
    resetPonder: () => {},
    onRematchStart: () => {},
    applyMoveRef: createRef<ApplyMove>(),
  } as unknown as Parameters<typeof useLiveMatch>[0];
  const { result } = renderHook(() => useLiveMatch(args));
  return { result, setLinkNotice };
}

describe("a live ending that does not reach the server", () => {
  beforeEach(() => {
    store.clear();
    vi.restoreAllMocks();
    // A refused `lm_end` logs the server's reason, which is the point of it.
    // Here it is the expected path, so it stays out of the run's output.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("says so, in the terms of the button that was pressed", async () => {
    const { result, setLinkNotice } = mount(
      route({
        lm_create: () => ok({ match_id: "m1", token: "tok" }),
        lm_end: () => refused(),
        lm_fetch: () => ok(null),
      })
    );
    await act(async () => void (await result.current.createLiveMatch("w")));
    expect(result.current.live?.seat?.token).toBe("tok");

    await act(async () => void (await result.current.endMatch("resign")));
    expect(setLinkNotice).toHaveBeenCalledWith(expect.stringContaining("have not resigned"));
    // The press changed nothing, so the match is still there to press again on.
    expect(result.current.live?.outcome).toBeNull();
  });

  it("names the offer that still stands when a decline fails", async () => {
    const { result, setLinkNotice } = mount(
      route({
        lm_create: () => ok({ match_id: "m1", token: "tok" }),
        lm_end: () => refused(),
        lm_fetch: () => ok(null),
      })
    );
    await act(async () => void (await result.current.createLiveMatch("w")));
    await act(async () => void (await result.current.endMatch("draw_decline")));
    expect(setLinkNotice).toHaveBeenCalledWith(expect.stringContaining("offer still stands"));
  });

  it("clears a stale notice once one gets through", async () => {
    const { result, setLinkNotice } = mount(
      route({
        lm_create: () => ok({ match_id: "m1", token: "tok" }),
        lm_end: () => ok({ outcome: "b", draw_offer: null, status: "over" }),
        lm_fetch: () => ok(null),
      })
    );
    await act(async () => void (await result.current.createLiveMatch("w")));
    await act(async () => void (await result.current.endMatch("resign")));
    expect(setLinkNotice).toHaveBeenCalledWith(null);
    // Straight onto the board, without waiting for a poll to bring it back.
    expect(result.current.live?.outcome).toBe("b");
  });
});
