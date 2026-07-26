/**
 * Experiments 4 + 5 re-measured at HEAD:
 *   - full EvoChess bitboard search (`searchEvoTT`) vs the reference
 *     `EvoChessGame` negamax in ai.ts (`engineConfig.backend = "chessjs"`),
 *     at equal depth, PST eval on both sides;
 *   - plain `searchEvo` (no TT) vs `searchEvoTT` (Zobrist TT + ID).
 */
import { sampleCorpus } from "./corpus";
import { engineConfig, searchRoot } from "../src/evochess/ai";
import { fromEvoGame } from "../src/evochess/evoBitboard";
import { searchEvo, searchEvoTT } from "../src/evochess/evoSearch";

const games = sampleCorpus(12);
console.log(`# corpus: ${games.length} middlegame positions from a seeded random walk\n`);

const DEPTHS = [3, 4, 5];

// ---- Experiment 5: plain vs TT ------------------------------------------
console.log(`## Experiment 5 — Zobrist TT + iterative deepening (PST eval)`);
console.log(`| depth | plain nodes | TT nodes | node ratio | plain ms | TT ms | speedup |`);
console.log(`|------:|------------:|---------:|-----------:|---------:|------:|--------:|`);
for (const d of DEPTHS) {
  let plainNodes = 0, ttNodes = 0, plainMs = 0, ttMs = 0, scoreMismatch = 0;
  for (const g of games) {
    const s1 = fromEvoGame(g);
    let t0 = performance.now();
    const a = searchEvo(s1, d);
    plainMs += performance.now() - t0;
    plainNodes += a.nodes;

    const s2 = fromEvoGame(g);
    t0 = performance.now();
    const b = searchEvoTT(s2, d);
    ttMs += performance.now() - t0;
    ttNodes += b.nodes;

    if (a.score !== b.score) scoreMismatch++;
  }
  console.log(
    `| ${d} | ${plainNodes.toLocaleString()} | ${ttNodes.toLocaleString()} | ` +
    `${(plainNodes / ttNodes).toFixed(2)}× | ${plainMs.toFixed(0)} | ${ttMs.toFixed(0)} | ` +
    `**${(plainMs / ttMs).toFixed(2)}×** |` +
    (scoreMismatch ? `  <-- ${scoreMismatch} SCORE MISMATCHES` : ``)
  );
}

// ---- Experiment 4: bitboard backend vs chessjs backend -------------------
console.log(`\n## Experiment 4 — bitboard backend vs ai.ts chessjs backend (PST eval, equal depth)`);
console.log(`| depth | chessjs ms | chessjs nodes | bitboard ms | bitboard nodes | speedup |`);
console.log(`|------:|-----------:|--------------:|------------:|---------------:|--------:|`);
for (const d of [3, 4]) {
  let refMs = 0, refNodes = 0, bbMs = 0, bbNodes = 0;
  for (const g of games) {
    engineConfig.backend = "chessjs";
    const a = searchRoot(g, d, 1, false);
    refMs += a.timeMs; refNodes += a.nodes;

    engineConfig.backend = "bitboard";
    const b = searchRoot(g, d, 1, false);
    bbMs += b.timeMs; bbNodes += b.nodes;
  }
  console.log(
    `| ${d} | ${refMs.toFixed(0)} | ${refNodes.toLocaleString()} | ${bbMs.toFixed(0)} | ` +
    `${bbNodes.toLocaleString()} | **${(refMs / bbMs).toFixed(1)}×** |`
  );
}
engineConfig.backend = "bitboard";
