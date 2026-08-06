import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmModal } from "../components/ConfirmModal";
import { NEW_GAME_MODE, type ConfirmState } from "../appTypes";

const newGame: ConfirmState = { kind: "restart", what: "new-game", mode: "human-ai", aiColor: "b", level: "easy" };

function open(onNewGame: (choice: "ai" | "live" | "otb", seat: "w" | "b") => void) {
  render(
    <ConfirmModal
      confirmAction={newGame}
      totalPlies={0}
      liveActive={false}
      close={() => {}}
      confirmCancelBtnRef={{ current: null }}
      onPlayHere={() => {}}
      onNewGame={onNewGame}
      onStartNewGame={() => {}}
      onLeaveLive={() => {}}
    />
  );
}

describe("New Game", () => {
  it("lands each option in the right mode", () => {
    expect(NEW_GAME_MODE.ai).toBe("human-ai");
    expect(NEW_GAME_MODE.live).toBe("human-human");
    expect(NEW_GAME_MODE.otb).toBe("human-human");
  });

  it("picks the mode with no confirm step: choosing is the confirmation", () => {
    const onNewGame = vi.fn();
    open(onNewGame);
    fireEvent.click(screen.getByRole("button", { name: "Computer" }));
    expect(onNewGame).toHaveBeenCalledWith("ai", "w");
    fireEvent.click(screen.getByRole("button", { name: "Over the board" }));
    expect(onNewGame).toHaveBeenLastCalledWith("otb", "w");
  });

  it("starts a match on the seat the Live row is set to, not the panel's colour", () => {
    const onNewGame = vi.fn();
    open(onNewGame);
    fireEvent.click(screen.getByRole("button", { name: "Black" }));
    fireEvent.click(screen.getByRole("button", { name: "Friend" }));
    expect(onNewGame).toHaveBeenCalledWith("live", "b");
  });
});
