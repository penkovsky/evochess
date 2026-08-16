import { formatPuzzleDateShort, type DailyPuzzle, type PuzzleOutcomes } from "../evochess/dailyPuzzle";

/**
 * The published puzzles, newest first, as a list to pick from.
 *
 * On the shared `.modal` idiom rather than the mobile sheet: the banner that
 * opens it shows at every width, so this is one dialog, not two surfaces.
 */
export function PuzzleListModal({
  puzzles,
  outcomes,
  activeDate,
  onSelect,
  onClose,
}: {
  /** Newest first. `[0]` is today's, and is labelled as such. */
  puzzles: DailyPuzzle[];
  outcomes: PuzzleOutcomes;
  /** The date on the board, marked so the list says where you are. */
  activeDate: string | null;
  onSelect: (row: DailyPuzzle) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal puzzle-list-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Puzzles"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <p>Puzzles</p>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {/* Scrolls inside the dialog so the page never does. */}
        <ul className="puzzle-list">
          {puzzles.map((row, i) => {
            const outcome = outcomes[row.date];
            const active = row.date === activeDate;
            return (
              <li key={row.date}>
                <button
                  type="button"
                  className={`puzzle-row${active ? " active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(row)}
                >
                  <span className="puzzle-row-date">{i === 0 ? "Today" : formatPuzzleDateShort(row.date)}</span>
                  <span className="puzzle-row-mate">Mate in {row.mateIn}</span>
                  <span className={`puzzle-row-mark ${outcome ?? "none"}`} aria-label={outcome}>
                    {outcome === "solved" ? "✓" : outcome === "failed" ? "✗" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
