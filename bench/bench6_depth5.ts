/** Fixed-depth backend comparison across depths, same 6 positions throughout. */
import { sampleCorpus } from "./corpus";
import { engineConfig, searchRoot, type EngineBackend } from "../src/evochess/ai";
const games = sampleCorpus(12).slice(0, 6);
console.log(`| depth | chessjs ms | chessjs nodes | bitboard ms | bitboard nodes | wall speedup | ms/node ratio |`);
console.log(`|------:|-----------:|--------------:|------------:|---------------:|-------------:|--------------:|`);
for (const d of [3, 4, 5]) {
  const out: Record<string, { ms: number; nodes: number }> = {};
  for (const backend of ["bitboard", "chessjs"] as EngineBackend[]) {
    engineConfig.backend = backend;
    let ms = 0, nodes = 0;
    for (const g of games) { const r = searchRoot(g, d, 1, false); ms += r.timeMs; nodes += r.nodes; }
    out[backend] = { ms, nodes };
  }
  const c = out.chessjs, b = out.bitboard;
  console.log(`| ${d} | ${c.ms.toFixed(0)} | ${c.nodes.toLocaleString()} | ${b.ms.toFixed(0)} | ${b.nodes.toLocaleString()} | **${(c.ms / b.ms).toFixed(1)}x** | ${((c.ms / c.nodes) / (b.ms / b.nodes)).toFixed(1)}x |`);
}
