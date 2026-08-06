import type { Dispatch, SetStateAction } from "react";
import type { Color } from "chess.js";
import type { AiLevel } from "../evochess/ai";
import { PUZZLE_LEVEL, type Mode, type RestartReason } from "../appTypes";

/** Exported so the desktop panel and the mobile sheet mount it from one object. */
export interface ControlsPanelProps {
  mode: Mode;
  aiColor: Color;
  level: AiLevel;
  /** A puzzle fixes the whole setup, so the pickers show it and are locked. */
  puzzleActive: boolean;
  /**
   * A match is on the board. It is human-vs-human, but neither of that mode's
   * switches applies to one, so neither is offered.
   */
  liveActive: boolean;
  autoFlip: boolean;
  timerEnabled: boolean;
  timerMinutes: number;
  /** Disables the color/timer settings that only make sense before the first move. */
  hasHistory: boolean;
  onRestart: (what: RestartReason, next: { mode: Mode; aiColor: Color; level: AiLevel }, apply?: () => void) => void;
  setAiColor: (color: Color) => void;
  setLevel: (level: AiLevel) => void;
  setAutoFlip: Dispatch<SetStateAction<boolean>>;
  setTimerEnabled: (enabled: boolean) => void;
  setTimerMinutes: (minutes: number) => void;
  setTimeUp: (color: Color | null) => void;
  resetClock: (minutes: number) => void;
}

export function ControlsPanel({
  mode,
  aiColor,
  level,
  puzzleActive,
  liveActive,
  autoFlip,
  timerEnabled,
  timerMinutes,
  hasHistory,
  onRestart,
  setAiColor,
  setLevel,
  setAutoFlip,
  setTimerEnabled,
  setTimerMinutes,
  setTimeUp,
  resetClock,
}: ControlsPanelProps) {
  return (
    <div className="controls">
      {/* No mode picker: changing mode always restarted the game, so it is a
          New Game option now (docs/live-match.md §Milestone 2). */}
      {mode === "human-ai" && (
        <>
          <div className="color-picker" role="group" aria-label="Your color">
            {(
              [
                { label: "White", value: "b" },
                { label: "Black", value: "w" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={aiColor === opt.value ? "active" : ""}
                disabled={puzzleActive}
                onClick={() => {
                  const newAiColor = opt.value;
                  if (newAiColor === aiColor) return;
                  onRestart("color", { mode, aiColor: newAiColor, level }, () => setAiColor(newAiColor));
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="level-picker" role="group" aria-label="AI level">
            {(
              [
                { label: "Easy", value: "easy" },
                { label: "Zen", value: "zen" },
                { label: "Fun", value: "fun" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={(puzzleActive ? PUZZLE_LEVEL : level) === opt.value ? "active" : ""}
                disabled={puzzleActive}
                onClick={() => {
                  const newLevel = opt.value;
                  if (newLevel === level) return;
                  onRestart("level", { mode, aiColor, level: newLevel }, () => setLevel(newLevel));
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
      {/* Neither switch has anything to say in a match. The board is oriented
          by the seat, and a match is untimed: the clock is local, so a flag
          only one side sees would split the two boards
          (docs/live-match.md §Shape). */}
      {mode === "human-human" && !liveActive && (
        <div className="controls-row">
          <button
            type="button"
            className={`toggle-btn ${autoFlip ? "pressed" : ""}`}
            aria-pressed={autoFlip}
            onClick={() => setAutoFlip((v) => !v)}
          >
            Auto flip
          </button>
          <button
            type="button"
            className={`toggle-btn ${timerEnabled ? "pressed" : ""}`}
            aria-pressed={timerEnabled}
            disabled={hasHistory}
            onClick={() => {
              const enabled = !timerEnabled;
              setTimerEnabled(enabled);
              if (enabled) {
                setTimeUp(null);
                resetClock(timerMinutes);
              }
            }}
          >
            Clock
          </button>
        </div>
      )}
      {mode === "human-human" && timerEnabled && !liveActive && (
        <label>
          Minutes per side:
          <input
            type="number"
            min={1}
            max={180}
            value={timerMinutes}
            disabled={hasHistory}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              setTimerMinutes(minutes);
              resetClock(minutes);
            }}
          />
        </label>
      )}
    </div>
  );
}
