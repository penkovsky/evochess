/**
 * Material ladder diagnostic (`nnue-data-coverage-spec.md`). The fast, direct
 * check on whether the coverage fix worked: does the net now value material
 * monotonically and with the right sign, especially on rooks and queens —
 * the exact place the original 40k-position net was measured to be blind
 * ("+1 queen" scored ~0.02 instead of ~9, and a Black queen advantage scored
 * as good for White).
 *
 * Run under vite-node:
 *
 *     npx vite-node training/ladder.ts -- \
 *         --weights training/checkpoints/net-weights.json
 *
 * Each row is an isolated, otherwise-bare-kings position with one material
 * swing, White to move, so "truth" is just that swing's pawn-unit value
 * (matching PIECE_VALUES / rookValue in ai.ts). "Net" is the raw NNUE output,
 * side-to-move-relative (White here) — the same convention the spec's own
 * ladder table used.
 */
import { readFileSync } from "node:fs";
import { EvoChessGame } from "../src/evochess/game";
import { material } from "../src/evochess/ai";
import { evaluateNNUE, loadWeights, setNnueWeights, type NnueWeights } from "../src/evochess/nnue";

interface Rung {
  name: string;
  fen: string;
  truth: number;
}

// Bare kings (e1/e8) plus one isolated material swing each, White to move.
// Kings are far enough apart that no rung is accidentally a check/mate.
const RUNGS: Rung[] = [
  { name: "even (kings only)", fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1", truth: 0 },
  { name: "+1 pawn", fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", truth: 1 },
  { name: "+1 knight", fen: "4k3/8/8/8/8/8/8/4K1N1 w - - 0 1", truth: 3 },
  { name: "+1 bishop", fen: "4k3/8/8/8/8/8/8/4K1B1 w - - 0 1", truth: 3 },
  // No rookCharges entry -> full charges (5), per game.ts's default.
  { name: "+1 rook (full charges)", fen: "4k3/8/8/8/8/8/8/4K2R w - - 0 1", truth: 5 },
  { name: "+1 queen", fen: "4k3/8/8/8/8/8/8/4K2Q w - - 0 1", truth: 9 },
  { name: "+2 queens", fen: "3QK2Q/8/8/8/8/8/8/4k3 w - - 0 1", truth: 18 },
  { name: "Black +1 queen", fen: "3qk3/8/8/8/8/8/8/4K3 w - - 0 1", truth: -9 },
];

function parseArgs(argv: string[]): { weightsPath: string } {
  const args = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : argv;
  let weightsPath = "training/checkpoints/net-weights.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--weights") weightsPath = args[++i];
  }
  return { weightsPath };
}

function loadGame(fen: string): EvoChessGame {
  const game = new EvoChessGame();
  game.chess.load(fen);
  return game;
}

function main(): void {
  const { weightsPath } = parseArgs(process.argv.slice(2));
  const weights: NnueWeights = loadWeights(JSON.parse(readFileSync(weightsPath, "utf8")));
  setNnueWeights(weights);

  const rows = RUNGS.map((rung) => {
    const game = loadGame(rung.fen);
    // Sanity check: every rung must actually be the material swing it claims.
    const actualMaterial = material(game);
    const net = evaluateNNUE(game); // side-to-move-relative; all rungs are White to move
    return { ...rung, actualMaterial, net };
  });

  const header = ["rung", "truth", "material()", "net"].map((h) => h.padEnd(24)).join("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      [row.name, row.truth.toFixed(2), row.actualMaterial.toFixed(2), row.net.toFixed(4)]
        .map((c) => String(c).padEnd(24))
        .join("")
    );
  }

  // -- automated checks on the properties the spec's success criteria ask for --
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.net]));
  const checks: { label: string; pass: boolean }[] = [
    { label: "monotonic: 0 < pawn < minor < rook < queen", pass: byName["even (kings only)"] < byName["+1 pawn"] && byName["+1 pawn"] < byName["+1 knight"] && byName["+1 knight"] < byName["+1 rook (full charges)"] && byName["+1 rook (full charges)"] < byName["+1 queen"] },
    { label: "+2 queens > +1 queen", pass: byName["+2 queens"] > byName["+1 queen"] },
    { label: "+1 queen clearly positive (> +5)", pass: byName["+1 queen"] > 5 },
    { label: "Black +1 queen is negative for White", pass: byName["Black +1 queen"] < 0 },
  ];
  console.log();
  console.log("checks:");
  for (const c of checks) {
    console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.label}`);
  }
  const allPass = checks.every((c) => c.pass);
  console.log();
  console.log(allPass ? "LADDER: all checks passed" : "LADDER: at least one check failed");
  process.exit(allPass ? 0 : 1);
}

main();
