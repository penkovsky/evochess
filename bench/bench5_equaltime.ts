/**
 * The user-visible payoff: at the UI's real time budget (Fun = 800 ms), how
 * deep does each backend get? A faster substrate does not finish sooner — it
 * searches deeper in the same wall clock.
 */
import { readFileSync } from "node:fs";
import { sampleCorpus } from "./corpus";
import { engineConfig, searchRootTimed, type EngineBackend } from "../src/evochess/ai";
import { loadWeights, setNnueWeights, type SerializedWeights } from "../src/evochess/nnue";

const BUDGET = Number(process.env.BUDGET ?? 800);
const games = sampleCorpus(12);

function run(label: string, useNnue: boolean) {
  console.log(`\n### ${label} (${BUDGET} ms budget, 12 positions)`);
  console.log(`| backend | avg depth | min | max | avg nodes | avg ms |`);
  console.log(`|---|---:|---:|---:|---:|---:|`);
  for (const backend of ["chessjs", "bitboard"] as EngineBackend[]) {
    engineConfig.backend = backend;
    const depths: number[] = [];
    let nodes = 0, ms = 0;
    for (const g of games) {
      const r = searchRootTimed(g, BUDGET, 1, 64, useNnue);
      depths.push(r.depth); nodes += r.nodes; ms += r.timeMs;
    }
    const avg = depths.reduce((a, b) => a + b, 0) / depths.length;
    console.log(
      `| ${backend} | **${avg.toFixed(2)}** | ${Math.min(...depths)} | ${Math.max(...depths)} | ` +
      `${Math.round(nodes / games.length).toLocaleString()} | ${(ms / games.length).toFixed(0)} |`
    );
  }
}

run("PST eval", false);

const serialized = JSON.parse(readFileSync("public/net-weights.json", "utf8")) as SerializedWeights;
setNnueWeights(loadWeights(serialized));
run("NNUE eval (shipped net)", true);

engineConfig.backend = "bitboard";
