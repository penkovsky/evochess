import type { ReactNode } from "react";
import type { MobileWidget } from "../appTypes";

const TITLE: Record<MobileWidget, string> = {
  rules: "Rules summary",
  log: "Move log",
  settings: "Settings",
};

/**
 * The mobile widget drawer: same idea as a hamburger side menu, but
 * anchored to the bottom edge, where the thumb and the bar that opened
 * it already are. It scrolls inside itself so the page never does.
 */
export function MobileWidgetSheet({
  widget,
  onClose,
  children,
}: {
  widget: MobileWidget;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={TITLE[widget]}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <h2>{TITLE[widget]}</h2>
          <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
