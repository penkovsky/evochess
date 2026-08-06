import type { MouseEvent as ReactMouseEvent } from "react";
import type { MobileWidget } from "../appTypes";
import { BookIcon, CapIcon, GearIcon, PuzzleIcon, ShareIcon } from "../Icons";

const WIDGETS = [
  { id: "settings" as const, label: "Settings", Icon: GearIcon },
  { id: "log" as const, label: "Move log", Icon: BookIcon },
];

/**
 * Phone-only: the panel is hidden at this width, so its widgets are reached
 * here instead. Tapping an icon slides that widget up from the bottom edge
 * as a sheet. While a sheet is open its backdrop covers this bar, so the
 * next tap anywhere — including on an icon — dismisses it rather than
 * switching widgets.
 *
 * Five buttons is the ceiling: that is what fits at a 320px viewport with
 * thumb-sized targets, and the bar must not wrap or scroll sideways. So the
 * puzzle took the rules summary's slot, and the rules moved into the settings
 * sheet.
 */
export function MobileBar({
  openTutorial,
  openWidget,
  onPuzzle,
  puzzleFresh,
  onShare,
}: {
  openTutorial: () => void;
  openWidget: (widget: MobileWidget) => void;
  /** Null when there is no puzzle to offer, which hides the button entirely. */
  onPuzzle: (() => void) | null;
  /** Today's puzzle not opened yet. */
  puzzleFresh: boolean;
  onShare: (e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) => void;
}) {
  return (
    <div className="mobile-bar" role="group" aria-label="Widgets">
      <button
        type="button"
        className="widget-btn primary"
        aria-label="Learn Evo Basics"
        title="Learn Evo Basics"
        onClick={openTutorial}
      >
        <CapIcon />
      </button>
      {WIDGETS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className="widget-btn"
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          onClick={() => openWidget(id)}
        >
          <Icon />
        </button>
      ))}
      {/* Not a widget either: it puts today's puzzle on the board. */}
      {onPuzzle && (
        <button
          type="button"
          className={`widget-btn${puzzleFresh ? " puzzle-fresh" : ""}`}
          aria-label="Puzzle of the day"
          title="Puzzle of the day"
          onClick={onPuzzle}
        >
          <PuzzleIcon />
        </button>
      )}
      {/* Not a widget: it never opens the sheet above. */}
      <button
        type="button"
        className="widget-btn"
        aria-label="Share position"
        title="Share position"
        onClick={(e) => onShare(e, true)}
      >
        <ShareIcon />
      </button>
    </div>
  );
}
