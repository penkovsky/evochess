import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Color } from "chess.js";
import type { EvoChessGame } from "../evochess/game";
import type { Mode } from "../appTypes";

export interface UseGameClock {
  /** Remaining seconds per side. A ref, not state: it changes many times per
   *  second and reaches the screen through `rerender()`. */
  clockRef: RefObject<Record<Color, number>>;
  /** One reading per ply, index-aligned with the position history, so a
   *  takeback restores the clock instead of resetting it. */
  clockHistoryRef: RefObject<Record<Color, number>[]>;
  timerEnabled: boolean;
  setTimerEnabled: Dispatch<SetStateAction<boolean>>;
  timerMinutes: number;
  setTimerMinutes: Dispatch<SetStateAction<number>>;
  timeUp: Color | null;
  setTimeUp: Dispatch<SetStateAction<Color | null>>;
  resetClock: (minutes: number) => void;
}

export interface UseGameClockArgs {
  gameRef: RefObject<EvoChessGame>;
  /** Held off until the save has been read, so a resumed clock isn't ticked
   *  down from its default before the saved reading lands. */
  loaded: boolean;
  mode: Mode;
  /** True while a modal owns the screen, which pauses the clock. */
  paused: boolean;
  rerender: () => void;
}

/** The human-vs-human clock: the readings, the per-ply history a takeback
 *  restores from, and the tick. Off by default. */
export function useGameClock({ gameRef, loaded, mode, paused, rerender }: UseGameClockArgs): UseGameClock {
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(10);
  const [timeUp, setTimeUp] = useState<Color | null>(null);
  const clockRef = useRef<Record<Color, number>>({ w: 600, b: 600 });
  const clockHistoryRef = useRef<Record<Color, number>[]>([]);

  function resetClock(minutes: number) {
    clockRef.current = { w: minutes * 60, b: minutes * 60 };
  }

  // Ticks the clock for whichever side is to move. Restarts (with a fresh
  // reference timestamp) whenever the turn changes, the modal opens/closes,
  // or the timer is toggled, so no stale elapsed time leaks across a pause.
  useEffect(() => {
    if (!loaded || !timerEnabled || mode !== "human-human" || timeUp) return;
    const game = gameRef.current;
    if (game.isGameOver() || paused) return;
    if (game.moveLog.length === 0) return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      const turn = game.turn;
      const remaining = Math.max(0, clockRef.current[turn] - elapsed);
      clockRef.current[turn] = remaining;
      if (remaining <= 0) {
        setTimeUp(turn);
        clearInterval(id);
      }
      rerender();
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, timerEnabled, mode, paused, timeUp, gameRef.current.turn, gameRef.current.moveLog.length]);

  return {
    clockRef,
    clockHistoryRef,
    timerEnabled,
    setTimerEnabled,
    timerMinutes,
    setTimerMinutes,
    timeUp,
    setTimeUp,
    resetClock,
  };
}
