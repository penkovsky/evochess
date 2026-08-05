import type { MobileWidget } from "../appTypes";
import { ControlsPanel, type ControlsPanelProps } from "./ControlsPanel";
import { MoveLog } from "./MoveLog";
import { RulesSummary } from "./RulesSummary";
import type { MoveLogProps } from "./AppPanel";

/** The body of the mobile bottom sheet: whichever widget the bar opened. */
export function MobileSheetContent({
  widget,
  controls,
  moveLog,
  onSelectPly,
}: {
  widget: MobileWidget;
  controls: ControlsPanelProps;
  moveLog: MoveLogProps;
  onSelectPly: (ply: number) => void;
}) {
  if (widget === "log") return <MoveLog {...moveLog} onSelectPly={onSelectPly} />;
  return (
    <>
      <ControlsPanel {...controls} />
      {/* The puzzle button took the rules' slot in the bar, so this is the
          phone route to them. The sheet already scrolls inside itself, and the
          wrapper is what keeps their styling. */}
      <div className="rules-summary sheet-rules">
        <h3>Rules summary</h3>
        <RulesSummary />
      </div>
    </>
  );
}
