import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { MobileWidget } from "../appTypes";

export interface UseMobileWidget {
  /** Which widget the sheet is showing, or null when it is closed. */
  widget: MobileWidget | null;
  setWidget: Dispatch<SetStateAction<MobileWidget | null>>;
}

/**
 * The mobile bottom sheet: which widget is open, its Escape handling, and the
 * page-scroll lock it needs while it covers the page.
 *
 * `blocked` is true while a dialog that binds Escape for itself is up, so the
 * sheet doesn't also close on the same keypress.
 */
export function useMobileWidget(blocked: boolean): UseMobileWidget {
  const [widget, setWidget] = useState<MobileWidget | null>(null);

  // Escape closes the widget sheet — but not while the promotion prompt or a
  // confirmation is up, which bind Escape for themselves and take priority.
  // The settings switches open a confirmation from inside the sheet, so
  // without this Escape would dismiss both at once.
  useEffect(() => {
    if (!widget || blocked) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setWidget(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [widget, blocked]);

  // The sheet is position:fixed, so nothing stops the page scrolling behind
  // it; and a rotate/resize past the breakpoint would leave it stranded over
  // the desktop layout, where the bar that opened it no longer exists.
  //
  // iOS Safari ignores `overflow: hidden` on the body for touch scrolling, so
  // the lock has to pin the body itself — which drops the scroll position, and
  // so has to carry it in `top` and restore it on the way out.
  useEffect(() => {
    if (!widget) return;
    const { style } = document.body;
    const previous = { overflow: style.overflow, position: style.position, top: style.top, width: style.width };
    const scrollY = window.scrollY;
    style.overflow = "hidden";
    style.position = "fixed";
    style.top = `-${scrollY}px`;
    style.width = "100%";
    const mq = window.matchMedia("(max-width: 600px)");
    const onChange = () => {
      if (!mq.matches) setWidget(null);
    };
    mq.addEventListener("change", onChange);
    return () => {
      Object.assign(style, previous);
      window.scrollTo(0, scrollY);
      mq.removeEventListener("change", onChange);
    };
  }, [widget]);

  return { widget, setWidget };
}
