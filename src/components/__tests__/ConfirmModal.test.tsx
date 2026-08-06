import { fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "../ConfirmModal";
import type { ConfirmState } from "../../appTypes";

function renderModal(confirmAction: ConfirmState, over: { totalPlies?: number; liveActive?: boolean } = {}) {
  const onLeaveLive = vi.fn();
  const onStartNewGame = vi.fn();
  const onNewGame = vi.fn();
  const { container } = render(
    <ConfirmModal
      confirmAction={confirmAction}
      totalPlies={over.totalPlies ?? 4}
      close={() => {}}
      confirmCancelBtnRef={createRef<HTMLButtonElement>()}
      onPlayHere={() => {}}
      onNewGame={onNewGame}
      onStartNewGame={onStartNewGame}
      onLeaveLive={onLeaveLive}
      liveActive={over.liveActive ?? false}
    />,
  );
  return { container, onLeaveLive, onStartNewGame, onNewGame };
}

const NEW_GAME: ConfirmState = { kind: "restart", what: "new-game", mode: "human-human", aiColor: "b", level: "zen" };
const SWITCH: ConfirmState = { kind: "restart", what: "level", mode: "human-ai", aiColor: "b", level: "fun" };

/** The nth option button in the New Game stack. */
function options(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>(".mode-option")];
}

describe("ConfirmModal", () => {
  it("asks about the seat, not the moves, when leaving a match", () => {
    const { container, onLeaveLive, onStartNewGame } = renderModal({ kind: "leave-live" });
    expect(container.textContent).toContain("Leave this match?");
    expect(container.textContent).toContain("cannot take your seat back");
    expect(container.textContent).not.toContain("Discard the");
    container.querySelector<HTMLButtonElement>(".danger-btn")!.click();
    expect(onLeaveLive).toHaveBeenCalledOnce();
    expect(onStartNewGame).not.toHaveBeenCalled();
  });

  it("names the seat on a restart that gives one up", () => {
    const { container } = renderModal(NEW_GAME, { liveActive: true });
    expect(container.textContent).toContain("give up your seat");
    expect(container.textContent).toContain("Discard the game?(4 moves)");
  });

  it("counts no moves when there are none to count", () => {
    // A match created or joined but not yet played still costs the seat.
    const { container } = renderModal(NEW_GAME, { totalPlies: 0, liveActive: true });
    expect(container.textContent).not.toContain("Discard the");
    expect(container.textContent).toContain("give up your seat");
  });

  it("says nothing about a seat in an ordinary game", () => {
    const { container } = renderModal(NEW_GAME);
    expect(container.textContent).toContain("Discard the game?(4 moves)");
    expect(container.textContent).not.toContain("seat");
  });

  it("offers the three modes, and picking one is the confirmation", () => {
    const { container, onNewGame } = renderModal(NEW_GAME);
    const [ai, live, otb] = options(container);
    expect([ai.textContent, live.textContent, otb.textContent]).toEqual([
      "Computer",
      "Friend",
      "Over the board",
    ]);
    // No second step: no danger button to press after choosing.
    expect(container.querySelector(".danger-btn")).toBeNull();
    fireEvent.click(ai);
    expect(onNewGame).toHaveBeenCalledWith("ai", "w");
    fireEvent.click(otb);
    expect(onNewGame).toHaveBeenLastCalledWith("otb", "w");
  });

  it("passes the picked seat to a live game, and White by default", () => {
    const { container, onNewGame } = renderModal(NEW_GAME);
    const [, live] = options(container);
    fireEvent.click(live);
    expect(onNewGame).toHaveBeenLastCalledWith("live", "w");
    const black = container.querySelector<HTMLButtonElement>('.seat-picker button[aria-label="Black"]')!;
    fireEvent.click(black);
    fireEvent.click(live);
    expect(onNewGame).toHaveBeenLastCalledWith("live", "b");
  });

  it("keeps the two-button confirm for a settings switch", () => {
    const { container, onStartNewGame, onNewGame } = renderModal(SWITCH);
    expect(container.textContent).toContain("Switch level?");
    expect(options(container)).toHaveLength(0);
    container.querySelector<HTMLButtonElement>(".danger-btn")!.click();
    expect(onStartNewGame).toHaveBeenCalledOnce();
    expect(onNewGame).not.toHaveBeenCalled();
  });
});
