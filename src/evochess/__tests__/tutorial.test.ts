import { describe, it, expect } from "vitest";
import {
  LESSONS,
  RULES_SUMMARY,
  buildLessonGame,
  isSuggestionAvailable,
  optionsMatch,
  type Lesson,
} from "../tutorial";
import { EvoChessGame, ROOK_CHARGES } from "../game";
import { searchLevel } from "../ai";
import type { Square } from "chess.js";

/**
 * The tutorial's teaching positions are reached by replaying moves, so an
 * illegal or mistyped move anywhere in a lesson breaks that lesson at runtime
 * with no warning at authoring time. These tests replay every lesson end to
 * end — setup, learner steps and scripted replies — and assert the resulting
 * position is the one the lesson text claims.
 */

/** Replays a whole lesson, asserting each move is legal as it goes. */
function playLesson(lesson: Lesson): EvoChessGame {
  const game = buildLessonGame(lesson);
  for (const [i, step] of lesson.steps.entries()) {
    const where = `${lesson.id} step ${i + 1}`;
    const legal = game
      .legalMoves()
      .some((m) => m.from === step.play.from && m.to === step.play.to);
    expect(legal, `${where}: ${step.play.from}${step.play.to} is not a legal move`).toBe(true);
    const options = step.play.anyDowngrade ? { downgradeTo: "n" as const } : step.play.options ?? {};
    expect(() => game.applyMove(step.play.from, step.play.to, options), where).not.toThrow();
    expect(game.isGameOver(), `${where}: the game ended mid-lesson`).toBe(false);
    if (step.reply) {
      const replyLegal = game
        .legalMoves()
        .some((m) => m.from === step.reply!.from && m.to === step.reply!.to);
      expect(replyLegal, `${where} reply: ${step.reply.from}${step.reply.to} is illegal`).toBe(true);
      expect(
        () => game.applyMove(step.reply!.from, step.reply!.to, step.reply!.options ?? {}),
        `${where} reply`
      ).not.toThrow();
      expect(game.isGameOver(), `${where}: the game ended after the reply`).toBe(false);
    }
  }
  return game;
}

describe("tutorial lessons", () => {
  it("has lessons with unique ids", () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(LESSONS.map((l) => [l.id, l] as const))("%s: setup position is reachable", (_id, lesson) => {
    expect(() => buildLessonGame(lesson)).not.toThrow();
    const game = buildLessonGame(lesson);
    // Every lesson teaches White, so White must be the side to move throughout.
    expect(game.turn).toBe("w");
    expect(game.isGameOver()).toBe(false);
  });

  it.each(LESSONS.map((l) => [l.id, l] as const))("%s: every scripted move is legal", (_id, lesson) => {
    playLesson(lesson);
  });

  it.each(LESSONS.map((l) => [l.id, l] as const))("%s: has instructional copy", (_id, lesson) => {
    expect(lesson.title.length).toBeGreaterThan(0);
    expect(lesson.blurb.length).toBeGreaterThan(0);
    expect(lesson.outro.length).toBeGreaterThan(0);
    expect(lesson.steps.length).toBeGreaterThan(0);
    for (const step of lesson.steps) {
      expect(step.text.length).toBeGreaterThan(0);
      expect(step.hint.length).toBeGreaterThan(0);
      expect(step.note.length).toBeGreaterThan(0);
    }
  });

  // Each lesson claims a specific outcome in its outro; check the rules engine
  // actually produces it, so the copy can't quietly drift from the mechanics.

  it("first-piece: three pawn moves put a Knight on c3", () => {
    const game = playLesson(LESSONS[0]);
    expect(game.chess.get("c3" as Square)).toMatchObject({ type: "n", color: "w" });
    // Spent, not banked: the right was earned and used on the same move.
    expect(game.minorRights.w).toBe(0);
    expect(game.pawnMoveProgress.w).toBe(0);
  });

  // This lesson's position is hand-built rather than played into, so the state
  // the lesson text describes is asserted here instead of being guaranteed by
  // a legal setup line.
  it("rooks: opens with two blue dots and a Bishop on the long diagonal", () => {
    const game = buildLessonGame(LESSONS[1]);
    expect(game.chess.get("g2" as Square)).toMatchObject({ type: "b", color: "w" });
    expect(game.minorMoveProgress.w).toBe(2);
    expect(game.rookRights.w).toBe(0);
    // Black's Rook shows a badge of its own, which the last lesson builds on.
    expect(game.rookCharges.get("d2" as Square)).toBe(4);
    // Unstated fields must default to empty rather than to anything surprising.
    expect(game.minorRights).toEqual({ w: 0, b: 0 });
    expect(game.pawnMoveProgress).toEqual({ w: 0, b: 0 });
    expect(game.rookLocked.size).toBe(0);
  });

  it("rooks: the third minor move puts a fully-charged Rook on a8, with check", () => {
    const game = playLesson(LESSONS[1]);
    expect(game.chess.get("a8" as Square)).toMatchObject({ type: "r", color: "w" });
    expect(game.rookCharges.get("a8" as Square)).toBe(ROOK_CHARGES);
    expect(game.rookRights.w).toBe(0);
    expect(game.minorMoveProgress.w).toBe(0);
    // The lesson's punchline: arriving as a Rook is what makes it check.
    expect(game.moveLog[0]).toBe("Ba8=R+");
  });

  it("rooks: the check the Rook gives has exactly one answer", () => {
    const game = buildLessonGame(LESSONS[1]);
    const [step] = LESSONS[1].steps;
    game.applyMove(step.play.from, step.play.to, step.play.options ?? {});
    // Black's only legal move is the scripted reply, so the lesson survives
    // any opponent: Easy cannot wander off it even if it wants to.
    expect(game.legalMoves().map((m) => `${m.from}${m.to}`)).toEqual(["d2d8"]);
  });

  it("charges: the Rook reaches the last lesson with exactly one charge", () => {
    const game = buildLessonGame(LESSONS[2]);
    expect(game.chess.get("c2" as Square)).toMatchObject({ type: "r", color: "w" });
    expect(game.rookCharges.get("c2" as Square)).toBe(1);
  });

  // The lesson asserts this in prose rather than spending a step on it, so
  // the claim is checked here instead.
  it("charges: a non-Rook move leaves the charge untouched", () => {
    const game = buildLessonGame(LESSONS[2]);
    game.applyMove("a2", "a3");
    expect(game.rookCharges.get("c2" as Square), "a pawn move must not spend a charge").toBe(1);
  });

  it("charges: spending the last charge downgrades and locks the piece out", () => {
    const game = playLesson(LESSONS[2]);
    const landed = game.chess.get("c7" as Square);
    expect(landed?.color).toBe("w");
    expect(["n", "b"]).toContain(landed?.type);
    expect(game.rookCharges.has("c7" as Square), "a downgraded piece keeps no charges").toBe(false);
    expect(game.rookLocked.has("c7" as Square), "must be barred from becoming a Rook again").toBe(true);
    expect(game.canRookPromote("w", "c7" as Square)).toBe(false);
  });

  it("charges: the downgrade accepts a Bishop just as well as a Knight", () => {
    const lesson = LESSONS[2];
    const game = buildLessonGame(lesson);
    const [rookStep] = lesson.steps;
    game.applyMove(rookStep.play.from, rookStep.play.to, { downgradeTo: "b" });
    expect(game.chess.get("c7" as Square)).toMatchObject({ type: "b", color: "w" });
  });
});

describe("RULES_SUMMARY", () => {
  // The lessons teach three rules by playing them; the rest of the rule set
  // exists only here. Banking in particular lost its lesson, so this list is
  // now the only place in the app that explains it.
  it("covers the rules the lessons deliberately leave out", () => {
    const text = RULES_SUMMARY.join(" ").toLowerCase();
    expect(text).toContain("accumulate");
    expect(text).toContain("one promotion");
    expect(text).toContain("castling");
  });
});

describe("isSuggestionAvailable", () => {
  it("is true for the move a step is about to suggest", () => {
    const lesson = LESSONS[0];
    expect(isSuggestionAvailable(buildLessonGame(lesson), lesson.steps[0])).toBe(true);
  });

  it("is false once the suggested move has been played", () => {
    const lesson = LESSONS[0];
    const game = buildLessonGame(lesson);
    const step = lesson.steps[0];
    game.applyMove(step.play.from, step.play.to, step.play.options ?? {});
    // The pawn has left e2, so the lesson's e2-e4 is no longer on offer.
    expect(isSuggestionAvailable(game, step)).toBe(false);
  });

  it("is false when the suggested piece has been captured", () => {
    // The Rook lesson asks the Bishop on g2 to move; take it off and the ask
    // is void — exactly what a real opponent capturing it would do.
    const lesson = LESSONS[1];
    const game = buildLessonGame(lesson);
    expect(isSuggestionAvailable(game, lesson.steps[0])).toBe(true);
    game.chess.remove("g2" as Square);
    expect(isSuggestionAvailable(game, lesson.steps[0])).toBe(false);
  });
});

/**
 * Black is played by the Easy AI, not by the scripted `reply`, so the lessons
 * have to hold up against a real opponent. They cannot be *guaranteed* to —
 * chess can overtake a lesson, which is why the tutorial detects divergence
 * and says so. What these tests pin down is that the common path works: the
 * opening lessons survive real opposition, and divergence is always something
 * the tutorial can see coming rather than a crash.
 */
describe("lessons against the Easy opponent", () => {
  /** One Easy reply, exactly as the worker would produce it. */
  function easyReply(game: EvoChessGame, seed: number) {
    return searchLevel(game, "easy", seed).move;
  }

  const SEEDS = [1, 7, 12345];

  it.each(SEEDS)("lesson 1 can be completed with Easy replying (seed %i)", (seed) => {
    const lesson = LESSONS[0];
    const game = buildLessonGame(lesson);
    for (const step of lesson.steps) {
      expect(isSuggestionAvailable(game, step), "lesson 1 must survive any Easy reply").toBe(true);
      game.applyMove(step.play.from, step.play.to, step.play.options ?? {});
      if (game.isGameOver()) break;
      const reply = easyReply(game, seed);
      expect(reply, "Easy must find a move").not.toBeNull();
      game.applyMove(reply!.from, reply!.to, reply!.options);
    }
    // The lesson's whole point still lands: a Knight, earned, on c3 — and it
    // is still standing after Black's reply, rather than having been taken.
    expect(game.chess.get("c3" as Square)).toMatchObject({ type: "n", color: "w" });
  });

  /**
   * The failure this guards against: a lesson that spans several moves asks
   * the same piece to move each time, so if the opponent captures it the
   * lesson becomes impossible to finish rather than merely off-script. Every
   * square that piece visits has to be out of reach — see the note on
   * ROOK_ON_LAST_CHARGE for the rules the squares were chosen by.
   */
  it.each(SEEDS)("the Rook lesson completes against Easy (seed %i)", (seed) => {
    const lesson = LESSONS[1];
    const game = buildLessonGame(lesson);
    for (const step of lesson.steps) {
      expect(
        isSuggestionAvailable(game, step),
        `the Bishop must still be able to play ${step.play.from}-${step.play.to}`
      ).toBe(true);
      game.applyMove(step.play.from, step.play.to, step.play.options ?? {});
      if (game.isGameOver()) break;
      const reply = easyReply(game, seed);
      game.applyMove(reply!.from, reply!.to, reply!.options);
    }
    // The lesson completed: a Rook, earned, with a full set of charges.
    expect(game.chess.get("a8" as Square)).toMatchObject({ type: "r", color: "w" });
    expect(game.rookCharges.get("a8" as Square)).toBe(ROOK_CHARGES);
  });

  it.each(SEEDS)("the Rook is still there to burn out in the last lesson (seed %i)", (seed) => {
    const lesson = LESSONS[2];
    const game = buildLessonGame(lesson);
    for (const step of lesson.steps) {
      expect(isSuggestionAvailable(game, step), `must still be able to play ${step.play.from}-${step.play.to}`).toBe(
        true
      );
      const options = step.play.anyDowngrade ? { downgradeTo: "n" as const } : step.play.options ?? {};
      game.applyMove(step.play.from, step.play.to, options);
      if (game.isGameOver()) break;
      const reply = easyReply(game, seed);
      game.applyMove(reply!.from, reply!.to, reply!.options);
    }
    // The Rook spent its last charge and became a minor piece, locked out.
    expect(game.rookLocked.has("c7" as Square)).toBe(true);
  });

  it.each(LESSONS.map((l) => [l.id, l] as const))(
    "%s: every step either offers a legal move or is detectably diverged",
    (_id, lesson) => {
      // Never throws, never silently suggests an impossible move: whatever the
      // opponent does, the tutorial can always tell which state it is in.
      const game = buildLessonGame(lesson);
      for (const step of lesson.steps) {
        if (!isSuggestionAvailable(game, step)) return; // diverged, and detected
        const options = step.play.anyDowngrade ? { downgradeTo: "n" as const } : step.play.options ?? {};
        expect(() => game.applyMove(step.play.from, step.play.to, options)).not.toThrow();
        if (game.isGameOver()) return;
        const reply = easyReply(game, 99);
        expect(reply).not.toBeNull();
        expect(() => game.applyMove(reply!.from, reply!.to, reply!.options)).not.toThrow();
      }
    }
  );
});

describe("optionsMatch", () => {
  const plain = { from: "e2" as Square, to: "e4" as Square };

  it("accepts the exact promotion the step teaches", () => {
    expect(optionsMatch({ ...plain, options: { minorPromo: "n" } }, { minorPromo: "n" })).toBe(true);
    expect(optionsMatch({ ...plain, options: { rookPromo: true } }, { rookPromo: true })).toBe(true);
  });

  it("rejects the wrong piece", () => {
    expect(optionsMatch({ ...plain, options: { minorPromo: "n" } }, { minorPromo: "b" })).toBe(false);
  });

  it("rejects declining a promotion the step wanted taken", () => {
    expect(optionsMatch({ ...plain, options: { minorPromo: "n" } }, {})).toBe(false);
    expect(optionsMatch({ ...plain, options: { rookPromo: true } }, {})).toBe(false);
  });

  it("rejects taking a promotion the step wanted declined", () => {
    expect(optionsMatch({ ...plain, options: {} }, { minorPromo: "n" })).toBe(false);
    expect(optionsMatch({ ...plain, options: {} }, { rookPromo: true })).toBe(false);
  });

  it("accepts either minor for a mandatory downgrade, but not neither", () => {
    const step = { ...plain, anyDowngrade: true };
    expect(optionsMatch(step, { downgradeTo: "n" })).toBe(true);
    expect(optionsMatch(step, { downgradeTo: "b" })).toBe(true);
    expect(optionsMatch(step, {})).toBe(false);
  });
});
