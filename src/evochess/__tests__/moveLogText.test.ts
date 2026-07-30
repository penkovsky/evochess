import { describe, it, expect } from "vitest";
import { formatMoveLog } from "../moveLogText";

describe("formatMoveLog", () => {
  it("is empty for an unplayed game", () => {
    expect(formatMoveLog([])).toBe("");
  });

  it("numbers each pair on its own line", () => {
    expect(formatMoveLog(["e4", "e5", "Nf3", "Nc6"])).toBe("1. e4 e5\n2. Nf3 Nc6");
  });

  it("leaves a trailing White move unpaired", () => {
    expect(formatMoveLog(["e4", "e5", "Nf3"])).toBe("1. e4 e5\n2. Nf3");
  });
});
