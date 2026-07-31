import { useEffect, useRef } from "react";

/**
 * The move log, owning its own scroll-to-bottom. A component rather than a
 * render helper because the panel copy and the mobile copy are both mounted
 * (one is hidden by CSS), and a single shared ref cannot serve two elements.
 */
export function MoveLog({
  moveLog,
  blackFirst,
  browsePly,
  browsable,
  onSelectPly,
}: {
  moveLog: string[];
  /**
   * Whether the first ply is Black's, as it is on a shared position with Black
   * to move. The first pair then opens with a "..." placeholder so Black's
   * plies stay in the second column.
   */
  blackFirst: boolean;
  /** null means live; a ply is highlighted and scrolled to when set. */
  browsePly: number | null;
  /**
   * Whether the snapshots browsing needs actually exist. They are built as
   * moves are played and are not persisted, so a game resumed from the
   * autosave has a move log and no positions to go with it. The entries are
   * rendered as plain text then, rather than as tap targets that do nothing.
   */
  browsable: boolean;
  onSelectPly: (ply: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const currentPly = browsePly ?? moveLog.length;
  // null is the placeholder standing in for the White move that never
  // happened, so pairs line up with the columns either way. An empty log stays
  // empty: a shared position with Black to move has `blackFirst` before any
  // move is played, and the placeholder alone would render a phantom "1. ..."
  // row next to "No moves yet.".
  const plies: (string | null)[] = blackFirst && moveLog.length > 0 ? [null, ...moveLog] : moveLog;
  const offset = blackFirst ? 1 : 0;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (browsePly !== null) {
      el.querySelector<HTMLButtonElement>(".log-move.current")?.scrollIntoView({ block: "nearest" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  });
  return (
    <div className="log" ref={ref}>
      {/* Without this the sheet's height:auto log collapses to nothing on an
          unplayed game, leaving a drawer with a title and no body. Not a
          <div>: the e2e specs count `.log > div` to mean "moves played". */}
      {moveLog.length === 0 && <p className="log-empty">No moves yet.</p>}
      {plies
        .filter((_, i) => i % 2 === 0)
        .map((white, n) => {
          const black = plies[n * 2 + 1];
          // Ply numbers are 1-based over `moveLog`, so the placeholder shifts
          // every entry back by one.
          const whitePly = n * 2 + 1 - offset;
          const blackPly = n * 2 + 2 - offset;
          const entry = (san: string | null, ply: number) =>
            san === null ? (
              "..."
            ) : browsable ? (
              <button
                type="button"
                className={`log-move${currentPly === ply ? " current" : ""}`}
                onClick={() => onSelectPly(ply)}
              >
                {san}
              </button>
            ) : (
              san
            );
          return (
            <div key={n}>
              {n + 1}. {entry(white, whitePly)}
              {black && <> {entry(black, blackPly)}</>}
            </div>
          );
        })}
    </div>
  );
}
