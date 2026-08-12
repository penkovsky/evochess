/**
 * Interactive tutorial: a short scripted course teaching the three rules that
 * make EvoChess not-chess. Earning minor pieces from pawn moves, banking
 * those rights, earning a Rook from minor-piece moves, and Rook charges.
 *
 * Everything here is data plus pure helpers; the UI lives in Tutorial.tsx.
 * A lesson reaches its teaching position one of two ways:
 *
 *  - `setup`: replaying moves from the standard start. The position is then
 *    internally consistent by construction. Counters, banked rights, rook
 *    charges and lock-outs are whatever real play produced. The cost is that
 *    the line has to be legal, which tutorial.test.ts checks move by move.
 *  - `position`: a hand-built board (`LessonPosition`) for the positions no
 *    plausible line reaches, e.g. a late-game puzzle with most of the material
 *    already gone. Here the counters are stated rather than earned, so the
 *    tests assert them explicitly instead of trusting the setup line.
 */
import type { Color, Square } from "chess.js";
import { EvoChessGame, type ApplyMoveOptions } from "./game";
import { deserializeGame } from "./serialize";

export interface ScriptedMove {
  from: Square;
  to: Square;
  options?: ApplyMoveOptions;
}

export interface StepMove extends ScriptedMove {
  /**
   * Accept either Knight or Bishop for a mandatory rook downgrade. The choice
   * is a genuine judgement call, so the tutorial shouldn't insist on one.
   */
  anyDowngrade?: boolean;
}

export interface TutorialStep {
  /** Instruction shown while the step waits for the learner's move. */
  text: string;
  /** Shown when they play something else. */
  hint: string;
  /** The move the learner is invited to play. */
  play: StepMove;
  /**
   * The reference continuation for Black. Black is normally played by the
   * Easy AI, so this is not what the learner will usually face; it exists as
   * the canonical line the lesson was written against (which is what
   * tutorial.test.ts checks), and as the fallback when no AI is available.
   */
  reply?: ScriptedMove;
  /**
   * The payoff: what this step's move did and why it matters. It is *not* a
   * screen of its own. The lesson never stops to be acknowledged, which on a
   * phone is a "Continue" tap between every move. Instead it becomes the
   * opening paragraph of the next step's card (or of the outro, for the last
   * step), so the learner reads what just happened and what to do next in one
   * breath. Optional: a step whose payoff the outro already states can omit it.
   */
  recap?: string;
}

/**
 * A hand-built teaching position: the FEN plus everything about EvoChess state
 * that a FEN cannot carry. Every counter defaults to zero and every map to
 * empty, so a lesson states only what it actually wants to be true.
 *
 * Which squares a lesson uses is a hard constraint, not a free choice. Black
 * is the Easy AI, so anything left en prise gets taken and any legal check
 * gets played. Three rules, learned the hard way from lessons that stranded
 * themselves, and every square in `LESSONS` is picked to satisfy them:
 *
 *  1. A piece a later step depends on must stand where Black cannot reach it.
 *     Otherwise the step asks for a move with no piece left to make it.
 *  2. The piece a lesson *produces* must not appear en prise, or the lesson's
 *     punchline is a blunder.
 *  3. White's King must stay out of check at the start of every step, or the
 *     step's own move is illegal and the lesson strands.
 *
 * The tests in tutorial.test.ts play each lesson out against the real Easy
 * opponent, which is what actually catches a square that breaks one of these.
 */
export interface LessonPosition {
  fen: string;
  minorRights?: Partial<Record<Color, number>>;
  rookRights?: Partial<Record<Color, number>>;
  /** Green dots: pawn moves banked toward the next minor-piece right. */
  pawnMoveProgress?: Partial<Record<Color, number>>;
  /** Blue dots: minor-piece moves banked toward the next Rook right. */
  minorMoveProgress?: Partial<Record<Color, number>>;
  /** Charges left on rooks already on the board; absent means a full five. */
  rookCharges?: Partial<Record<Square, number>>;
  /** Minor pieces barred from ever becoming a Rook again. */
  rookLocked?: Square[];
}

export interface Lesson {
  id: string;
  title: string;
  /** One line, shown on the lesson menu. */
  blurb: string;
  /** Replayed from the standard start to reach the teaching position. */
  setup?: ScriptedMove[];
  /** A hand-built position instead of a setup line. Takes precedence. */
  position?: LessonPosition;
  steps: TutorialStep[];
  /** The closing screen, one string per paragraph. */
  outro: string[];
}

export const LESSONS: Lesson[] = [
  {
    id: "first-piece",
    title: "Earn your first piece",
    blurb: "Why the board starts almost empty, and how to fill it.",
    setup: [],
    steps: [
      {
        text: "Look at the board: eight Pawns and a King each. No Queen, no Rooks, no Knights, no Bishops. In Evochess you don't start with an army. You grow one. Start by playing the Pawn to e4.",
        hint: "Move the e2 Pawn two squares forward, to e4.",
        play: { from: "e2", to: "e4" },
        reply: { from: "e7", to: "e5" },
        recap: "One green dot filled in under the board. That strip is your progress toward your next piece: every Pawn move fills a dot.",
      },
      {
        text: "Two more Pawn moves to go. Play b3.",
        hint: "Move the b2 Pawn to b3.",
        play: { from: "b2", to: "b3" },
        reply: { from: "b7", to: "b6" },
        recap: "Two dots. The strip above the board is Black's. They're earning pieces on the same terms you are, so watch it as closely as your own.",
      },
      {
        text: "This is the one. Play c3, your third Pawn move. A Knight or Bishop will be offered to you.",
        hint: "Move the c2 Pawn to c3 to complete three Pawn moves.",
        play: { from: "c2", to: "c3", options: { minorPromo: "n" } },
        recap: "The Pawn on c3 is now a Knight, and the green dots have reset to zero. Three more Pawn moves buys the next piece.",
      },
    ],
    outro: [
      "Three Pawn moves earned one minor piece. It appeared on c3, the square of the Pawn that just moved. That's the rule that shapes the whole game: the piece you get is the Pawn you just pushed, so which Pawn you move decides where your army grows.",
    ],
  },
  {
    id: "rooks",
    title: "Minors earn Rooks",
    blurb: "The same rule, one level up. Three minor moves buy a Rook.",
    // Late middlegame, and White is down to a King and a Bishop against a
    // Queen and a Rook. No plausible opening line reaches it, so it's built
    // rather than played into. See `LessonPosition`. The point of being this
    // far behind is that the Rook the lesson earns is the whole counterplay:
    // the Bishop slides the long diagonal into a8, arrives as a Rook, and
    // gives check on the back rank the same turn.
    position: {
      fen: "5k2/4ppp1/6q1/8/8/8/3r2B1/4K3 w - - 0 1",
      // Two blue dots already filled: this Bishop move is the third.
      minorMoveProgress: { w: 2 },
      rookCharges: { d2: 4 },
    },
    steps: [
      {
        text: "You're a Bishop against a Queen and a Rook. But look at the second row of dots under your side of the board: two of the three blue ones are filled. Blue counts moves by your Knights and Bishops, exactly as green counts Pawn moves. Every three earns a Rook, so make the third one count: Bishop all the way to a8, and take the Rook.",
        hint: "Slide the Bishop from g2 down the long diagonal to a8, then choose the Rook.",
        play: { from: "g2", to: "a8", options: { rookPromo: true } },
        reply: { from: "d2", to: "d8" },
        // No recap: the outro below already is this step's payoff, and a lesson
        // of one step would otherwise say the same thing twice on one screen.
      },
    ],
    outro: [
      "The Bishop travelled as a Bishop and landed as a Rook. A Rook on a8 is check along the empty back rank, which a Bishop there would never have been. The blue dots are back to zero, and the new Rook carries a small 5. That's a countdown.",
    ],
  },
  {
    id: "charges",
    title: "Rooks burn out",
    blurb: "A Rook is five moves of power, not a permanent piece.",
    // An endgame, built rather than played into: a Rook down to its last
    // charge, and one Pawn behind it. Black's King on d5 is what makes the
    // choice at the end a real one. A Knight landing on c7 checks it, a
    // Bishop doesn't, and neither can be taken by the Queen on a6.
    position: {
      fen: "8/2p5/q6P/3k4/8/8/2R5/4K3 w - - 0 1",
      rookCharges: { c2: 1 },
    },
    steps: [
      {
        text: "Every Rook is born with five charges, and the badge on c2 reads 1. This one has been busy. Charges are spent only when the Rook itself moves, so the rest of your army costs it nothing. But any Rook move now is one too many, so make it count: take the Pawn on c7.",
        hint: "Capture the c7 Pawn with the Rook on c2.",
        play: { from: "c2", to: "c7", anyDowngrade: true },
        // No recap, as in the Rook lesson: one step, so the payoff is the outro.
      },
    ],
    outro: [
      "Zero charges, so the Rook never really arrived: it made its move and collapsed into the minor piece you chose, on the same square, on the same turn.",
      "The grey dot on it marks that: permanently barred from becoming a Rook again. It can never cycle. Rooks are a burst of power to be timed, not a piece you keep.",
    ],
  },
];

/**
 * The whole rule set in seven lines. The reference the lessons don't replace.
 * Rendered both in the game panel and on the tutorial menu, so it lives here
 * rather than in either component: two copies of the rules is exactly the kind
 * of thing that drifts.
 */
export const RULES_SUMMARY: string[] = [
  "You shall start with only Pawns and a King. The pieces shall be earned.",
  "Every 3 Pawn moves shall earn a Knight or a Bishop, for any Pawn.",
  "Every 3 minor moves shall earn a Rook, for any minor.",
  "Rights shall keep until spent. One per turn.",
  "Promote at once, or wait you can.",
  "5 moves a Rook shall last, then fall to a minor. Never to rise again.",
  "A Pawn on the last rank shall promote as in chess.",
  "Castle shall you not.",
];

/** A game at the lesson's teaching position: hand-built, or replayed into. */
export function buildLessonGame(lesson: Lesson): EvoChessGame {
  if (lesson.position) return buildPosition(lesson.position);
  const game = new EvoChessGame();
  for (const move of lesson.setup ?? []) {
    game.applyMove(move.from, move.to, move.options ?? {});
  }
  return game;
}

/** Zero for both colours. The default every `LessonPosition` field falls back to. */
function pair(partial: Partial<Record<Color, number>> | undefined): Record<Color, number> {
  return { w: partial?.w ?? 0, b: partial?.b ?? 0 };
}

function buildPosition(position: LessonPosition): EvoChessGame {
  return deserializeGame({
    fen: position.fen,
    minorRights: pair(position.minorRights),
    rookRights: pair(position.rookRights),
    pawnMoveProgress: pair(position.pawnMoveProgress),
    minorMoveProgress: pair(position.minorMoveProgress),
    moveLog: [],
    rookCharges: (position.rookCharges ?? {}) as Record<string, number>,
    rookLocked: position.rookLocked ?? [],
  });
}

/**
 * Whether the move a step suggests can still be played. Black is played by a
 * real opponent rather than a script, so a lesson can be overtaken by the
 * game: the Knight a lesson wants to move again may have been captured, or a
 * check may rule its move out. The tutorial checks this before presenting a
 * step and says so plainly instead of suggesting an impossible move.
 */
export function isSuggestionAvailable(game: EvoChessGame, step: TutorialStep): boolean {
  return game.legalMoves().some((m) => m.from === step.play.from && m.to === step.play.to);
}

/**
 * Whether the promotion/downgrade choice the learner made in the modal is the
 * one this step is teaching. Absent keys must match absent keys, so declining
 * a promotion the step suggested (or taking one it suggested declining) counts
 * as a different choice.
 *
 * A mismatch is not an error: the tutorial follows the learner off-script
 * rather than blocking them (see Tutorial.tsx). This only decides whether the
 * scripted line continues.
 */
export function optionsMatch(step: StepMove, chosen: ApplyMoveOptions): boolean {
  const expected = step.options ?? {};
  if (step.anyDowngrade) {
    // Either minor is accepted, but one must be chosen.
    if (chosen.downgradeTo === undefined) return false;
  } else if (expected.downgradeTo !== chosen.downgradeTo) {
    return false;
  }
  if (expected.minorPromo !== chosen.minorPromo) return false;
  if (expected.forcedPromo !== chosen.forcedPromo) return false;
  if (!!expected.rookPromo !== !!chosen.rookPromo) return false;
  return true;
}

/** Whether the learner picked up the right piece and put it on the right square. */
export function isStepSquarePair(step: StepMove, from: Square, to: Square): boolean {
  return step.from === from && step.to === to;
}
