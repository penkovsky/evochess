import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ControlsPanel, type ControlsPanelProps } from "../components/ControlsPanel";

function panel(over: Partial<ControlsPanelProps> = {}) {
  render(
    <ControlsPanel
      mode="human-human"
      aiColor="b"
      level="easy"
      puzzleActive={false}
      liveActive={false}
      autoFlip={false}
      timerEnabled={false}
      timerMinutes={10}
      hasHistory={false}
      onRestart={() => {}}
      setAiColor={() => {}}
      setLevel={() => {}}
      setAutoFlip={() => {}}
      setTimerEnabled={() => {}}
      setTimerMinutes={() => {}}
      setTimeUp={() => {}}
      resetClock={() => {}}
      {...over}
    />
  );
}

describe("the human-vs-human switches", () => {
  it("are offered over the board", () => {
    panel();
    expect(screen.getByRole("button", { name: "Clock" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Auto flip" })).toBeTruthy();
  });

  it("are not offered in a live match", () => {
    // Untimed, because a flag fall the opponent never sees would leave the two
    // boards with different results. And the seat orients the board, so auto
    // flip has nothing to do (docs/live-match.md §Shape).
    panel({ liveActive: true });
    expect(screen.queryByRole("button", { name: "Clock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Auto flip" })).toBeNull();
  });

  it("takes the minutes input with it, even if the clock was already on", () => {
    panel({ liveActive: true, timerEnabled: true });
    expect(screen.queryByLabelText(/Minutes per side/)).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("keeps the minutes input over the board", () => {
    panel({ timerEnabled: true });
    expect(screen.getByRole("spinbutton")).toBeTruthy();
  });

  it("is not offered against the computer either", () => {
    panel({ mode: "human-ai" });
    expect(screen.queryByRole("button", { name: "Clock" })).toBeNull();
  });
});
