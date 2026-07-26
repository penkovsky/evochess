/**
 * Experiment 6 re-measured at HEAD: end-to-end self-play throughput driving
 * real games (real termination, incl. threefold) through `EvoChessGame`,
 * chessjs backend vs bitboard backend, PST eval, equal depth.
 *
 * This is the number the NNUE data-generation pipeline actually pays.
 */
import { EvoChessGame } from "../src/evochess/game";
import { engineConfig, searchRoot, type EngineBackend } from "../src/evochess/ai";

const DEPTH = Number(process.env.DEPTH ?? 3);
const GAMES = Number(process.env.GAMES ?? 6);
const MAX_PLIES = 200;

function playGame(seed: number): { plies: number; ms: number } {
  const game = new EvoChessGame();
  let plies = 0;
  const t0 = performance.now();
  while (!game.isGameOver() && plies < MAX_PLIES) {
    const r = searchRoot(game, DEPTH, seed * 1000 + plies, false);
    if (!r.move) break;
    game.applyMove(r.move.from, r.move.to, r.move.options);
    plies++;
  }
  return { plies, ms: performance.now() - t0 };
}

const results: Record<string, { plies: number; ms: number }> = {};
for (const backend of ["bitboard", "chessjs"] as EngineBackend[]) {
  engineConfig.backend = backend;
  let plies = 0, ms = 0;
  for (let i = 0; i < GAMES; i++) {
    const r = playGame(i + 1);
    plies += r.plies; ms += r.ms;
  }
  results[backend] = { plies, ms };
  console.log(
    `${backend.padEnd(9)} ${GAMES} games, depth ${DEPTH}: ${plies} plies in ${(ms / 1000).toFixed(1)} s ` +
    `→ ${(ms / plies).toFixed(0)} ms/move, ${(GAMES / (ms / 1000)).toFixed(2)} games/s`
  );
}
console.log(
  `\nspeedup (ms/move): ${((results.chessjs.ms / results.chessjs.plies) / (results.bitboard.ms / results.bitboard.plies)).toFixed(1)}×`
);
engineConfig.backend = "bitboard";
