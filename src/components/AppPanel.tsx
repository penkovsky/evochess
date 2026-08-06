import type { MouseEvent } from "react";
import { PuzzleIcon, ShareIcon } from "../Icons";
import { ControlsPanel, type ControlsPanelProps } from "./ControlsPanel";
import { MoveLog } from "./MoveLog";
import { RulesSummary } from "./RulesSummary";

/** The move log's props, shared by the panel copy and the sheet copy. */
export interface MoveLogProps {
  moveLog: string[];
  blackFirst: boolean;
  browsePly: number | null;
  browsable: boolean;
}

/**
 * The desktop side panel. Hidden entirely on a phone (CSS), where the same
 * widgets are reached through the bar under the board.
 */
export function AppPanel({
  showInvite,
  openTutorial,
  hasPuzzle,
  puzzleFresh,
  openPuzzle,
  onShare,
  controls,
  moveLog,
  onSelectPly,
  openPanel,
  togglePanel,
}: {
  /** The banner is already asking, so this is only the permanent way back in. */
  showInvite: boolean;
  openTutorial: () => void;
  /** Hidden entirely when there is no puzzle: no disabled state, no placeholder. */
  hasPuzzle: boolean;
  /** Today's puzzle not opened yet. */
  puzzleFresh: boolean;
  openPuzzle: () => void;
  onShare: (e: MouseEvent<HTMLButtonElement>, viaSheet: boolean) => void;
  controls: ControlsPanelProps;
  moveLog: MoveLogProps;
  onSelectPly: (ply: number) => void;
  /** Log and rules share panel space, so only one is expanded at a time. */
  openPanel: "rules" | "log" | null;
  togglePanel: (key: "rules" | "log", isOpen: boolean) => void;
}) {
  return (
    <div className="panel">
      {!showInvite && (
        <button className="learn-btn" onClick={openTutorial}>
          Learn Evo Basics
        </button>
      )}
      {hasPuzzle && (
        <button
          type="button"
          className={`learn-btn share-btn${puzzleFresh ? " puzzle-fresh" : ""}`}
          aria-label="Puzzle of the day"
          title="Puzzle of the day"
          onClick={openPuzzle}
        >
          <PuzzleIcon /> Puzzle of the day
        </button>
      )}
      {/* The panel is desktop-only, so this one always opens the dialog: the
          URL field is the point of it. */}
      <button
        type="button"
        className="learn-btn share-btn"
        aria-label="Share position"
        title="Share position"
        onClick={(e) => onShare(e, false)}
      >
        <ShareIcon /> Share
      </button>
      <ControlsPanel {...controls} />
      <details className="collapsible" open={openPanel === "log"} onToggle={(e) => togglePanel("log", e.currentTarget.open)}>
        <summary>Move log</summary>
        <MoveLog {...moveLog} onSelectPly={onSelectPly} />
      </details>
      <details
        className="collapsible rules-summary"
        open={openPanel === "rules"}
        onToggle={(e) => togglePanel("rules", e.currentTarget.open)}
      >
        <summary>Rules summary</summary>
        <RulesSummary />
      </details>
    </div>
  );
}
