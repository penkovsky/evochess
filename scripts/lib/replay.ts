/**
 * Replaying a written move list against the rules engine. Shared by
 * `shareGame`, `gameToShareLinks` and `makeClip`.
 *
 * The game is its own parser: try every legal move with every option set the
 * rules allow, and keep the one whose note matches the written token.
 */
import { readFileSync } from "node:fs";
import type { Square } from "chess.js";
import { EvoChessGame, type ApplyMoveOptions } from "../../src/evochess/game";
import { planMove } from "../../src/evochess/moveOptions";

export interface Match {
  from: Square;
  to: Square;
  options: ApplyMoveOptions;
}

/** Numbered SAN, e.g. "1. e4 g5\n2. d4 b6". `#` lines are comments. */
export function readMoveTokens(path: string): string[] {
  return tokenize(readFileSync(path, "utf8"));
}

export function tokenize(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !/^\d+\.$/.test(t));
}

/** Decorations a log may carry that `applyMove`'s note may not. */
function norm(san: string): string {
  return san.replace(/[+#]/g, "").replace(/→/g, "-").trim();
}

/** Every option set the rules allow for this move, per `planMove`. */
function optionSets(game: EvoChessGame, from: Square, to: Square): ApplyMoveOptions[] {
  const intent = planMove(game, from, to);
  if (intent.kind === "reject") return [];
  if (intent.kind === "apply") return [intent.options];
  const m = intent.modal;
  if (m.kind === "forced") {
    return [{ forcedPromo: "q" }, { forcedPromo: "r" }, { forcedPromo: "n" }, { forcedPromo: "b" }];
  }
  if (m.kind === "downgrade") return [{ downgradeTo: "n" }, { downgradeTo: "b" }];
  const sets: ApplyMoveOptions[] = [{}];
  if (m.canMinor) sets.push({ minorPromo: "n" }, { minorPromo: "b" });
  if (m.canRook) sets.push({ rookPromo: true });
  return sets;
}

/**
 * The move whose note is `token`. Exact match first, then one ignoring the
 * decorations logs differ on. Ambiguity throws rather than guessing.
 */
export function findMatch(game: EvoChessGame, token: string): Match {
  const exact: Match[] = [];
  const loose: Match[] = [];
  const want = norm(token);
  for (const mv of game.legalMoves()) {
    for (const options of optionSets(game, mv.from, mv.to)) {
      const probe = game.copy();
      let note: string;
      try {
        note = probe.applyMove(mv.from, mv.to, options);
      } catch {
        continue;
      }
      if (note === token) exact.push({ from: mv.from, to: mv.to, options });
      else if (norm(note) === want) loose.push({ from: mv.from, to: mv.to, options });
    }
  }
  const matches = exact.length > 0 ? exact : loose;
  if (matches.length === 0) throw new Error(`no legal move matches "${token}"`);
  if (matches.length > 1) throw new Error(`"${token}" is ambiguous: ${matches.length} candidates match`);
  return matches[0];
}

/** Plays `token` and returns the note the engine wrote for it. */
export function playSan(game: EvoChessGame, token: string): string {
  const { from, to, options } = findMatch(game, token);
  return game.applyMove(from, to, options);
}

/** One game per ply: index n is the position after the nth move. */
export function replayAll(start: EvoChessGame, tokens: string[]): EvoChessGame[] {
  const game = start.copy();
  const plies = [game.copy()];
  for (const token of tokens) {
    playSan(game, token);
    plies.push(game.copy());
  }
  return plies;
}
