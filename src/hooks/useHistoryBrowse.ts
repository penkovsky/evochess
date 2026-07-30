import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from "react";
import type { EvoChessGame } from "../evochess/game";

/** Handlers for a button whose hold does one thing and whose tap does another. */
export interface HoldableHandlers {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onClick: () => void;
}

export interface UseHistoryBrowse {
  /** Which ply of the current game is on screen; null means live. */
  browsePly: number | null;
  enterBrowse: (ply: number) => void;
  browsePrev: () => void;
  browseNext: () => void;
  browseHome: () => void;
  browseLive: () => void;
  holdable: (onHold: () => void, onTap: () => void) => HoldableHandlers;
  onBoardTouchStart: (e: ReactTouchEvent) => void;
  onBoardTouchEnd: (e: ReactTouchEvent) => void;
}

export interface UseHistoryBrowseArgs {
  historyRef: RefObject<EvoChessGame[]>;
  /** Browsing away from a square drops whatever was selected on it. */
  setSelected: (square: null) => void;
  /** True while a modal or the mobile sheet owns the keyboard. */
  blocked: boolean;
}

const LONG_PRESS_MS = 500;
const SWIPE_THRESHOLD_PX = 40;

/**
 * Stepping back and forth through the current game: which ply is on screen,
 * and the three ways to move it (arrow keys, the chevrons under the board,
 * and a swipe across the board).
 */
export function useHistoryBrowse({ historyRef, setSelected, blocked }: UseHistoryBrowseArgs): UseHistoryBrowse {
  // Not persisted: a reload always lands on the live position. Deliberately a
  // free-floating index rather than "steps back from live", so a move arriving
  // while browsing (own or the AI's) grows historyRef underneath it without
  // moving what's on screen.
  const [browsePly, setBrowsePly] = useState<number | null>(null);

  // Lands on `ply`, clamped to live if it has reached or passed the end of
  // the recorded history (historyRef only holds positions strictly before the
  // live one).
  function enterBrowse(ply: number) {
    setSelected(null);
    const total = historyRef.current.length;
    setBrowsePly(ply >= total ? null : Math.max(0, ply));
  }

  function browsePrev() {
    const total = historyRef.current.length;
    if (browsePly === null) {
      if (total > 0) enterBrowse(total - 1);
    } else if (browsePly > 0) {
      enterBrowse(browsePly - 1);
    }
  }

  function browseNext() {
    if (browsePly === null) return;
    enterBrowse(browsePly + 1);
  }

  function browseHome() {
    if (historyRef.current.length > 0) enterBrowse(0);
  }

  function browseLive() {
    setSelected(null);
    setBrowsePly(null);
  }

  // Desktop history browsing: left/right steps a ply, Home/End jump to the
  // ends. Skipped while a modal/sheet is open or a text input has focus, so
  // it never steals keys from the promotion prompt, the widget sheet, or the
  // minutes-per-side field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (blocked) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        browsePrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        browseNext();
      } else if (e.key === "Home") {
        e.preventDefault();
        browseHome();
      } else if (e.key === "End") {
        e.preventDefault();
        browseLive();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, browsePly]);

  // Hold a chevron to jump to the end of the history it steps towards, the
  // way holding a rewind button seeks. The click that follows the release is
  // swallowed, or the jump would be undone by a step in the same direction.
  const longPressRef = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });

  function cancelLongPress() {
    if (longPressRef.current.timer !== null) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  }

  function holdable(onHold: () => void, onTap: () => void): HoldableHandlers {
    return {
      onPointerDown: () => {
        cancelLongPress();
        longPressRef.current.fired = false;
        longPressRef.current.timer = window.setTimeout(() => {
          longPressRef.current = { timer: null, fired: true };
          onHold();
        }, LONG_PRESS_MS);
      },
      onPointerUp: cancelLongPress,
      onPointerLeave: cancelLongPress,
      onPointerCancel: cancelLongPress,
      // A long press on a touch screen otherwise raises the selection or
      // context menu on top of the jump.
      onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
      onClick: () => {
        if (longPressRef.current.fired) {
          longPressRef.current.fired = false;
          return;
        }
        onTap();
      },
    };
  }

  // Swipe-to-step on the board, while browsing only. Safe to enable
  // unconditionally on the container: the board is read-only in that state,
  // so there is no drag gesture for it to collide with. Not used to *enter*
  // browsing — that would fire by accident on a drag from an empty square.
  const touchStartXRef = useRef<number | null>(null);

  function onBoardTouchStart(e: ReactTouchEvent) {
    touchStartXRef.current = browsePly !== null ? e.touches[0].clientX : null;
  }

  function onBoardTouchEnd(e: ReactTouchEvent) {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (dx > SWIPE_THRESHOLD_PX) browsePrev();
    else if (dx < -SWIPE_THRESHOLD_PX) browseNext();
  }

  return {
    browsePly,
    enterBrowse,
    browsePrev,
    browseNext,
    browseHome,
    browseLive,
    holdable,
    onBoardTouchStart,
    onBoardTouchEnd,
  };
}
