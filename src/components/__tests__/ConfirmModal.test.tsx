import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "../ConfirmModal";
import type { ConfirmState } from "../../appTypes";

function renderModal(confirmAction: ConfirmState, over: { totalPlies?: number; liveActive?: boolean } = {}) {
  const onLeaveLive = vi.fn();
  const onStartNewGame = vi.fn();
  const { container } = render(
    <ConfirmModal
      confirmAction={confirmAction}
      totalPlies={over.totalPlies ?? 4}
      close={() => {}}
      confirmCancelBtnRef={createRef<HTMLButtonElement>()}
      onPlayHere={() => {}}
      onStartNewGame={onStartNewGame}
      onLeaveLive={onLeaveLive}
      liveActive={over.liveActive ?? false}
    />,
  );
  return { container, onLeaveLive, onStartNewGame };
}

const NEW_GAME: ConfirmState = { kind: "restart", what: "new-game", mode: "human-human", aiColor: "b", level: "zen" };

describe("ConfirmModal", () => {
  it("asks about the seat, not the moves, when leaving a match", () => {
    const { container, onLeaveLive, onStartNewGame } = renderModal({ kind: "leave-live" });
    expect(container.textContent).toContain("Leave this match?");
    expect(container.textContent).toContain("cannot take your seat back");
    expect(container.textContent).not.toContain("discards");
    container.querySelector<HTMLButtonElement>(".danger-btn")!.click();
    expect(onLeaveLive).toHaveBeenCalledOnce();
    expect(onStartNewGame).not.toHaveBeenCalled();
  });

  it("names the seat on a restart that gives one up", () => {
    const { container } = renderModal(NEW_GAME, { liveActive: true });
    expect(container.textContent).toContain("give up your seat");
    expect(container.textContent).toContain("discards the 4 moves");
  });

  it("counts no moves when there are none to count", () => {
    // A match created or joined but not yet played still costs the seat.
    const { container } = renderModal(NEW_GAME, { totalPlies: 0, liveActive: true });
    expect(container.textContent).not.toContain("discards");
    expect(container.textContent).toContain("give up your seat");
  });

  it("says nothing about a seat in an ordinary game", () => {
    const { container } = renderModal(NEW_GAME);
    expect(container.textContent).toContain("discards the 4 moves");
    expect(container.textContent).not.toContain("seat");
  });
});
