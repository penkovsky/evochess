import { useEffect, useRef } from "react";

/**
 * The move log, owning its own scroll-to-bottom. A component rather than a
 * render helper because the panel copy and the mobile copy are both mounted
 * (one is hidden by CSS), and a single shared ref cannot serve two elements.
 */
export function MoveLog({
  moveLog,
  browsePly,
  browsable,
  onSelectPly,
}: {
  moveLog: string[];
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
      {moveLog
        .filter((_, i) => i % 2 === 0)
        .map((white, n) => {
          const black = moveLog[n * 2 + 1];
          const whitePly = n * 2 + 1;
          const blackPly = n * 2 + 2;
          const entry = (san: string, ply: number) =>
            browsable ? (
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
