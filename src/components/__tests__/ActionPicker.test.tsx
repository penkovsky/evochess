import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionPicker } from "../ActionPicker";

function renderPicker(
  over: {
    browsing?: boolean;
    puzzleActive?: boolean;
    liveActive?: boolean;
    onLiveMenu?: (() => void) | null;
  } = {}
) {
  const { browsing = false, ...rest } = over;
  const { container } = render(
    <ActionPicker
      extraClass=""
      browse={{
        browsing,
        browsePly: null,
        totalPlies: 4,
        browsePrevHoldable: {},
        browseNextHoldable: {},
        onBrowseLive: () => {},
      }}
      aiThinking={false}
      onRestart={() => {}}
      onTakeback={() => {}}
      setConfirmAction={() => {}}
      puzzleActive={false}
      liveActive={false}
      onLiveMenu={null}
      {...rest}
    />,
  );
  return container;
}

describe("ActionPicker", () => {
  it("offers takeback in an ordinary game, and play-from-here while browsing", () => {
    expect(renderPicker().querySelector(".takeback-btn")).not.toBeNull();
    expect(renderPicker({ browsing: true }).querySelector(".play-here-btn")).not.toBeNull();
  });

  it("holds the slot empty during a live match, since the line cannot rewind", () => {
    // Both actions rewind `moveLog`, and the server will not take a ply it
    // already holds, so a rewind would diverge the two boards for good.
    const live = renderPicker({ liveActive: true });
    expect(live.querySelector(".takeback-btn")).toBeNull();
    expect(live.querySelector(".action-slot-empty")).not.toBeNull();
    const browsingLive = renderPicker({ liveActive: true, browsing: true });
    expect(browsingLive.querySelector(".play-here-btn")).toBeNull();
    // Browsing itself stays: it is read-only.
    expect(browsingLive.querySelector(".back-btn")).not.toBeNull();
    // The row keeps its four fixed widths, so nothing moves under the thumb.
    expect(live.querySelectorAll(".action-picker > *")).toHaveLength(4);
  });

  it("reads New Game as Menu while a match is being played", () => {
    const onLiveMenu = vi.fn();
    const live = renderPicker({ liveActive: true, onLiveMenu });
    const btn = live.querySelector<HTMLButtonElement>(".new-game-btn")!;
    expect(btn.textContent).toBe("Menu");
    fireEvent.click(btn);
    expect(onLiveMenu).toHaveBeenCalledOnce();
    // Over, so the button is New Game again and the rematch is next to it.
    expect(renderPicker({ liveActive: true }).querySelector(".new-game-btn")!.textContent).toBe("New Game");
  });
});
