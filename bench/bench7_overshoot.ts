/**
 * Measurement-integrity check: `searchRootTimed` checks its deadline only
 * *between* iterative-deepening passes, so a search overshoots its budget by
 * however long its last completed iteration took. Asks whether that overshoot
 * is symmetric (a) between the two backends and (b) between PST and NNUE on
 * the same backend — i.e. whether a nominally "equal-time" A/B is fair.
 */
import { readFileSync } from "node:fs";
import { sampleCorpus } from "./corpus";
import { engineConfig, searchRootTimed, type EngineBackend } from "../src/evochess/ai";
import { loadWeights, setNnueWeights, type SerializedWeights } from "../src/evochess/nnue";

const BUDGET = Number(process.env.BUDGET ?? 800);
const games = sampleCorpus(12);
setNnueWeights(loadWeights(JSON.parse(readFileSync("public/net-weights.json", "utf8")) as SerializedWeights));

console.log(`### Deadline overshoot at a ${BUDGET} ms budget (12 positions)\n`);
console.log(`| backend | eval | avg actual ms | overshoot | min | max | avg depth |`);
console.log(`|---|---|---:|---:|---:|---:|---:|`);
const avgs: Record<string, number> = {};
for (const backend of ["chessjs", "bitboard"] as EngineBackend[]) {
  for (const useNnue of [false, true]) {
    engineConfig.backend = backend;
    const times: number[] = [];
    let depth = 0;
    for (const g of games) {
      const r = searchRootTimed(g, BUDGET, 1, 64, useNnue);
      times.push(r.timeMs); depth += r.depth;
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    avgs[`${backend}/${useNnue ? "nnue" : "pst"}`] = avg;
    console.log(
      `| ${backend} | ${useNnue ? "NNUE" : "PST"} | ${avg.toFixed(0)} | **${(avg / BUDGET).toFixed(2)}x** | ` +
      `${Math.min(...times).toFixed(0)} | ${Math.max(...times).toFixed(0)} | ${(depth / games.length).toFixed(2)} |`
    );
  }
}
console.log(`\nacross backends (PST):   bitboard gets ${(avgs["bitboard/pst"] / avgs["chessjs/pst"]).toFixed(2)}x chessjs's time`);
console.log(`across evals (bitboard): NNUE gets ${(avgs["bitboard/nnue"] / avgs["bitboard/pst"]).toFixed(2)}x PST's time`);
console.log(`across evals (chessjs):  NNUE gets ${(avgs["chessjs/nnue"] / avgs["chessjs/pst"]).toFixed(2)}x PST's time`);
engineConfig.backend = "bitboard";
