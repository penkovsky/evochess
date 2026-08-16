import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PuzzleListModal } from "../PuzzleListModal";
import type { DailyPuzzle, PuzzleOutcomes } from "../../evochess/dailyPuzzle";

const PUZZLES: DailyPuzzle[] = [
  { date: "2026-08-01", param: "AAA", mateIn: 2 },
  { date: "2026-07-31", param: "BBB", mateIn: 3 },
  { date: "2026-07-30", param: "CCC", mateIn: 4 },
];

function renderList(over: { outcomes?: PuzzleOutcomes; activeDate?: string | null } = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <PuzzleListModal
      puzzles={PUZZLES}
      outcomes={over.outcomes ?? {}}
      activeDate={over.activeDate ?? null}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
  return { container, onSelect, onClose };
}

describe("PuzzleListModal", () => {
  it("labels the newest row Today and dates the rest", () => {
    renderList();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("31 Jul 2026")).toBeTruthy();
    expect(screen.getByText("30 Jul 2026")).toBeTruthy();
    // The date is never rendered twice: "Today" replaces it, it does not join it.
    expect(screen.queryByText("1 Aug 2026")).toBeNull();
  });

  it("marks solved and failed, and leaves an untried date blank", () => {
    const { container } = renderList({
      outcomes: { "2026-08-01": "solved", "2026-07-31": "failed" },
    });
    const marks = container.querySelectorAll(".puzzle-row-mark");
    expect(marks[0].textContent).toBe("✓");
    expect(marks[1].textContent).toBe("✗");
    expect(marks[2].textContent).toBe("");
  });

  it("marks the row on the board", () => {
    const { container } = renderList({ activeDate: "2026-07-31" });
    const rows = container.querySelectorAll(".puzzle-row");
    expect(rows[0].className).not.toContain("active");
    expect(rows[1].className).toContain("active");
    expect(rows[1].getAttribute("aria-current")).toBe("true");
  });

  it("hands the picked row back, not its index or its date", () => {
    const { container, onSelect } = renderList();
    fireEvent.click(container.querySelectorAll(".puzzle-row")[2]);
    // The param is the point: it is what puts the position on the board.
    expect(onSelect).toHaveBeenCalledWith(PUZZLES[2]);
  });

  it("closes on the backdrop but not on the dialog itself", () => {
    const { container, onClose } = renderList();
    fireEvent.click(container.querySelector(".modal")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the mate length on every row", () => {
    renderList();
    expect(screen.getByText("Mate in 2")).toBeTruthy();
    expect(screen.getByText("Mate in 3")).toBeTruthy();
    expect(screen.getByText("Mate in 4")).toBeTruthy();
  });
});
