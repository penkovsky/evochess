/**
 * Interactive tutorial: a short scripted course teaching the three rules that
 * make EvoChess not-chess — earning minor pieces from pawn moves, banking
 * those rights, earning a Rook from minor-piece moves, and Rook charges.
 *
 * Everything here is data plus pure helpers; the UI lives in Tutorial.tsx.
 * A lesson reaches its teaching position one of two ways:
 *
 *  - `setup`: replaying moves from the standard start. The position is then
 *    internally consistent by construction — counters, banked rights, rook
 *    charges and lock-outs are whatever real play produced — at the cost of
 *    the line having to be legal, which tutorial.test.ts checks move by move.
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
  /** The payoff: what just happened and why it matters. */
  note: string;
}

/**
 * A hand-built teaching position: the FEN plus everything about EvoChess state
 * that a FEN cannot carry. Every counter defaults to zero and every map to
 * empty, so a lesson states only what it actually wants to be true.
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
  outro: string;
}

/**
 * 1.e4 e5 2.b3 b6 3.c3=N d6 — White converts the c-pawn into a Knight on c3,
 * the starting point for the lessons about what minor pieces then earn.
 *
 * Which squares a lesson uses is a hard constraint, not a free choice. Black
 * is the Easy AI, so anything left en prise gets taken and any legal check
 * gets played — and either can leave a multi-step lesson unfinishable, since
 * every later step asks the same piece to move again.
 *
 * Three rules follow, and every square below is chosen to satisfy them:
 *
 *  1. A piece a later step depends on must stand where no Black pawn can
 *     reach it. Ranks 1 and 2 are unreachable inside a lesson; rank 3 takes
 *     two pawn moves; ranks 4 and 5 are one pawn push from being attacked.
 *  2. The piece a lesson *produces* must not appear en prise, or the lesson's
 *     punchline is a blunder.
 *  3. White's King must stay out of check, or the checking move makes the
 *     suggested reply illegal and strands the lesson. Hence the d- and
 *     f-pawns never move: they block both diagonals into e1. Black banks
 *     promotion rights fast here, and a pawn evolving into a Bishop on a5 is
 *     check the moment d2 stands empty.
 *
 * So the Knight is made on c3, out of the c-pawn, leaving d2 and f2 at home.
 */
const KNIGHT_ON_C3: ScriptedMove[] = [
  { from: "e2", to: "e4" },
  { from: "e7", to: "e5" },
  { from: "b2", to: "b3" },
  { from: "b7", to: "b6" },
  { from: "c2", to: "c3", options: { minorPromo: "n" } },
  { from: "d7", to: "d6" },
];

/**
 * ...Ne2, Ng1 — the Knight has two minor moves banked, so the next Knight move
 * earns the Rook that the charges lesson goes on to burn out.
 *
 * This is the shape every lesson wants: the learner's own move is the *last*
 * one in a sequence, with the earlier moves pre-played in the setup. It keeps
 * the opponent from ever getting a turn between the steps that matter, which
 * is what used to strand these lessons — a captured Knight or a check, and
 * every later step was asking for an illegal move.
 *
 * The Knight tours e2 and g1 because those are squares Black can never touch
 * (rule 1 above). The route is pointless as chess; the learner never sees
 * these moves, only the position and the counters they produce.
 */
const KNIGHT_TWO_MOVES_IN: ScriptedMove[] = [
  ...KNIGHT_ON_C3,
  { from: "c3", to: "e2" },
  { from: "g7", to: "g6" },
  { from: "e2", to: "g1" },
  { from: "h7", to: "h6" },
];

/**
 * ...Nf3=R and four Rook moves, leaving a White Rook on c2 with a single
 * charge left — one move from burning out. The Rook walks back to c2 for the
 * same reason the Knight toured the back rank: Black cannot reach it there.
 */
const ROOK_ON_LAST_CHARGE: ScriptedMove[] = [
  ...KNIGHT_TWO_MOVES_IN,
  { from: "g1", to: "f3", options: { rookPromo: true } },
  { from: "a7", to: "a6" },
  // Four Rook moves: 5 charges down to 1.
  { from: "f3", to: "e3" },
  { from: "f7", to: "f6" },
  { from: "e3", to: "d3" },
  { from: "a6", to: "a5" },
  { from: "d3", to: "c3" },
  { from: "h6", to: "h5" },
  { from: "c3", to: "c2" },
  { from: "g6", to: "g5" },
];

export const LESSONS: Lesson[] = [
  {
    id: "first-piece",
    title: "Earn your first piece",
    blurb: "Why the board starts almost empty, and how to fill it.",
    setup: [],
    steps: [
      {
        text: "Look at the board: eight Pawns and a King each. No Queen, no Rooks, no Knights, no Bishops. In EvoChess you don't start with an army — you grow one. Start by playing the Pawn to e4.",
        hint: "Move the e2 Pawn two squares forward, to e4.",
        play: { from: "e2", to: "e4" },
        reply: { from: "e7", to: "e5" },
        note: "One green dot filled in under the board. That strip is your progress toward your next piece: every Pawn move fills a dot.",
      },
      {
        text: "Two more Pawn moves to go. Play b3.",
        hint: "Move the b2 Pawn to b3.",
        play: { from: "b2", to: "b3" },
        reply: { from: "b7", to: "b6" },
        note: "Two dots. The strip above the board is Black's — they're earning pieces on the same terms you are, so watch it as closely as your own.",
      },
      {
        text: "This is the one. Play c3 — your third Pawn move — and a Knight or Bishop will be offered to you.",
        hint: "Move the c2 Pawn to c3 to complete three Pawn moves.",
        play: { from: "c2", to: "c3", options: { minorPromo: "n" } },
        note: "The Pawn on c3 is now a Knight, and the green dots have reset to zero. Three more Pawn moves buys the next piece.",
      },
    ],
    outro:
      "Three Pawn moves earned one minor piece — and it appeared on c3, the square of the Pawn that just moved. That's the rule that shapes the whole game: the piece you get is the Pawn you just pushed, so which Pawn you move decides where your army grows.",
  },
  {
    id: "rooks",
    title: "Minors earn Rooks",
    blurb: "The same rule, one level up — three minor moves buy a Rook.",
    // Late middlegame, and White is down to a King and a Bishop against a
    // Queen and a Rook. No plausible opening line reaches it, so it's built
    // rather than played into — see `LessonPosition`. The point of being this
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
        text: "You're a Bishop against a Queen and a Rook — but look at the second row of dots under your side of the board: two of the three blue ones are filled. Blue counts moves by your Knights and Bishops, exactly as green counts Pawn moves. Every three earns a Rook, so make the third one count: Bishop all the way to a8, and take the Rook.",
        hint: "Slide the Bishop from g2 down the long diagonal to a8, then choose the Rook.",
        play: { from: "g2", to: "a8", options: { rookPromo: true } },
        reply: { from: "d2", to: "d8" },
        note: "The Bishop travelled as a Bishop and landed as a Rook — and a Rook on a8 is check along the empty back rank, which a Bishop there would never have been. The blue dots are back to zero, and the new Rook carries a small 5.",
      },
    ],
    outro:
      "Same shape as the Pawn rule, one level up: three moves, and the piece that just moved is the one that upgrades. The two ladders run side by side and never mix — Pawn moves fill only green dots, minor-piece moves only blue. That also makes the third move a choice of square: the piece arrives where you park it, so park it where a Rook hurts. Notice the small badge on it — that's a countdown, and the last lesson is about what it means.",
  },
  {
    id: "charges",
    title: "Rooks burn out",
    blurb: "A Rook is five moves of power, not a permanent piece.",
    setup: ROOK_ON_LAST_CHARGE,
    steps: [
      {
        text: "Every Rook is born with five charges, and the badge on c2 reads 1 — this one has been busy. Charges are spent only when the Rook itself moves, so the rest of your army costs it nothing. But any Rook move now is one too many, so make it count: take the Pawn on c7.",
        hint: "Capture the c7 Pawn with the Rook on c2.",
        play: { from: "c2", to: "c7", anyDowngrade: true },
        note: "Zero charges, so the Rook never really arrived: it made its move and collapsed into the minor piece you chose, on the same square, on the same turn.",
      },
    ],
    outro:
      "The Rook took the Pawn and immediately collapsed into a minor piece on the same square. That piece is permanently barred from becoming a Rook again, so it can never cycle. Rooks are a burst of power to be timed, not a piece you keep.",
  },
];

/**
 * The whole rule set in seven lines — the reference the lessons don't replace.
 * Rendered both in the game panel and on the tutorial menu, so it lives here
 * rather than in either component: two copies of the rules is exactly the kind
 * of thing that drifts.
 */
export const RULES_SUMMARY: string[] = [
  "Starts with only Pawns and Kings; other pieces are earned through play.",
  "Every 3 Pawn moves earns a right to promote the last Pawn that moved to a Knight or Bishop.",
  "Every 3 minor-piece (Knight/Bishop) moves earns a right to promote the last minor piece that moved to a Rook.",
  "Rights accumulate and carry over until used; only one promotion may be spent per turn.",
  "A Rook has 5 charges, spent only when it moves; at 0 it downgrades to a Knight or Bishop (owner's choice) and can never become a Rook again. Capturing a Rook is a normal capture.",
  "Reaching the 8th rank forces a standard Pawn promotion, as in chess.",
  "Castling is not defined.",
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

/** Zero for both colours — the default every `LessonPosition` field falls back to. */
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
