/**
 * Shared benchmark corpus: middlegame positions sampled through a seeded
 * random walk.
 */
import { EvoChessGame } from "../src/evochess/game";
import { legalTurns } from "../src/evochess/ai";
import { mulberry32 } from "../src/evochess/nnue";

export function sampleCorpus(count = 12, seed = 12345, firstPly = 20, stride = 4): EvoChessGame[] {
  const rng = mulberry32(seed);
  const out: EvoChessGame[] = [];
  const game = new EvoChessGame();
  let ply = 0;
  const maxPly = firstPly + stride * count + 40;
  while (out.length < count && ply < maxPly) {
    if (game.isGameOver()) break;
    const turns = legalTurns(game);
    if (turns.length === 0) break;
    const t = turns[Math.floor(rng() * turns.length)];
    game.applyMove(t.from, t.to, t.options);
    ply++;
    if (ply >= firstPly && (ply - firstPly) % stride === 0) out.push(game.copy());
  }
  return out;
}

export function describeCorpus(games: EvoChessGame[]): string {
  return games
    .map((g, i) => `  [${i}] ${g.chess.fen()}  rights w${g.minorRights.w}/${g.rookRights.w} b${g.minorRights.b}/${g.rookRights.b}`)
    .join("\n");
}
