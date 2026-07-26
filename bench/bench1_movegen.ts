/**
 * Experiment 2 re-measured at HEAD: bitboard move generation vs chess.js
 * `moves({verbose:true})`, plus a correctness cross-check (identical legal
 * move sets) and perft agreement.
 */
import { Chess } from "chess.js";
import { fromFen, generateLegal, moveString, perft } from "../src/evochess/bitboard";
import { EvoChessGame } from "../src/evochess/game";
import { legalTurns } from "../src/evochess/ai";
import { mulberry32 } from "../src/evochess/nnue";

// A wider corpus for the move-gen benchmark: sample many positions along a walk.
function walkFens(n: number, seed: number): string[] {
  const rng = mulberry32(seed);
  const out: string[] = [];
  let game = new EvoChessGame();
  while (out.length < n) {
    if (game.isGameOver()) game = new EvoChessGame();
    const turns = legalTurns(game);
    if (turns.length === 0) { game = new EvoChessGame(); continue; }
    const t = turns[Math.floor(rng() * turns.length)];
    game.applyMove(t.from, t.to, t.options);
    out.push(game.chess.fen());
  }
  return out;
}

const fens = walkFens(600, 987654);

// ---- correctness: identical legal move sets -----------------------------
let mismatches = 0;
let totalMoves = 0;
for (const fen of fens) {
  const c = new Chess(fen);
  const ref = new Set(
    c.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ""}`)
  );
  const bb = new Set(generateLegal(fromFen(fen)).map(moveString));
  totalMoves += bb.size;
  if (ref.size !== bb.size || [...ref].some((m) => !bb.has(m))) mismatches++;
}
console.log(`# Experiment 2 — move generation (${fens.length} positions)`);
console.log(`correctness: ${fens.length - mismatches}/${fens.length} identical legal-move sets (${totalMoves} moves)`);

// ---- perft(3) agreement -------------------------------------------------
let perftMismatch = 0;
let perftTotal = 0;
const perftFens = fens.slice(0, 30);
function refPerft(c: Chess, d: number): number {
  if (d === 0) return 1;
  let n = 0;
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    n += refPerft(c, d - 1);
    c.undo();
  }
  return n;
}
for (const fen of perftFens) {
  const a = perft(fromFen(fen), 3);
  const b = refPerft(new Chess(fen), 3);
  perftTotal += a;
  if (a !== b) perftMismatch++;
}
console.log(`perft(3): ${perftFens.length - perftMismatch}/${perftFens.length} match, ${perftTotal} total nodes`);

// ---- speed --------------------------------------------------------------
function timed(label: string, fn: () => void, iters: number): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  const per = (fens.length * iters) / (ms / 1000);
  console.log(`${label}: ${ms.toFixed(0)} ms for ${fens.length * iters} generations → ${per.toFixed(0)} gen/s`);
  return per;
}

const chessObjs = fens.map((f) => new Chess(f));
const positions = fens.map(fromFen);

const refRate = timed("chess.js moves({verbose:true})", () => {
  for (const c of chessObjs) c.moves({ verbose: true });
}, 3);

const bbRate = timed("bitboard generateLegal        ", () => {
  for (const p of positions) generateLegal(p);
}, 30);

console.log(`speedup: ${(bbRate / refRate).toFixed(1)}×`);
