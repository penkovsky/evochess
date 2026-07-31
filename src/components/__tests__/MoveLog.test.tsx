import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MoveLog } from "../MoveLog";

function renderLog(moveLog: string[], blackFirst: boolean) {
  const { container } = render(
    <MoveLog
      moveLog={moveLog}
      blackFirst={blackFirst}
      browsePly={null}
      browsable={false}
      onSelectPly={() => {}}
    />,
  );
  // The e2e specs count `.log > div` to mean "moves played", so the rows are
  // what this asserts on rather than the text.
  return Array.from(container.querySelectorAll(".log > div")).map((el) => el.textContent);
}

describe("MoveLog", () => {
  it("renders no rows for an empty log", () => {
    expect(renderLog([], false)).toEqual([]);
    expect(screen.getByText("No moves yet.")).toBeDefined();
  });

  it("renders no rows for an empty log with Black to move", () => {
    // A shared position with Black to move has `blackFirst` before any move is
    // played. The "1. ..." placeholder must not stand in as a played move.
    expect(renderLog([], true)).toEqual([]);
    expect(screen.getByText("No moves yet.")).toBeDefined();
  });

  it("pairs plies into numbered rows", () => {
    expect(renderLog(["e4", "e5", "Nf3"], false)).toEqual(["1. e4 e5", "2. Nf3"]);
  });

  it("opens with a placeholder when the first ply is Black's", () => {
    expect(renderLog(["e5", "Nf3", "Nc6"], true)).toEqual(["1. ... e5", "2. Nf3 Nc6"]);
  });
});
