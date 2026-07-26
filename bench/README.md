# `bench/` — engine performance benchmarks

Throwaway-quality scripts kept on purpose. A benchmark nobody can
re-run is a number nobody can check.

## Running

Each script is bundled once with esbuild and run under plain `node` — never
`vite-node`, for the same reason `training/` doesn't (a Vite server per process
dominates the measurement). From the repo root:

```bash
npx esbuild bench/bench2_search.ts --bundle --platform=node --format=esm \
  --target=node20 --outfile=bench/bench2.mjs && node bench/bench2.mjs
```

Scripts that load the net read `public/net-weights.json` relative to the
**repo root**, so run from there. The `.mjs` bundles are generated artifacts
and are gitignored; only the `.ts` sources are tracked.

Some scripts take env overrides: `BUDGET` (ms) for `bench5`/`bench7`,
`DEPTH`/`GAMES` for `bench4`.

## The corpus

`corpus.ts` is shared by every script: 12 middlegame EvoChess positions sampled
every 4 plies from ply 20 of a seeded (`12345`) random walk. **Do not change
the seed or sampling casually** — every recorded number is against this corpus,
and changing it silently invalidates all of them.

This matters more than it sounds. The same experiment at depth 4 measured
**18.4×** on the 12-position corpus and **11.5×** on a 6-position subset of the
*same* walk. An early attempt at the depth-5 trend compared 6 positions against
a 12-position depth-4 run and appeared to show the speedup *shrinking* with
depth; it does the opposite. Position choice moves these numbers more than
depth does.

## Reading the results

**Ratios within one run are meaningful. Absolute numbers across runs are not.**
PST eval measures ~0.00072 ms/eval here versus ~0.0031 ms in the original memo
— a 4× gap that is entirely machine and Node version, not code. Never diff an
absolute figure from one session against another and call it a regression.

Two further traps:

- **Never benchmark the net with `seededNet`.** Random weights emit noise,
  noise scrambles move ordering, and unordered alpha-beta stops pruning. That
  inflated "NNUE search cost" to 2.4× when the shipped net measures 1.30× — the
  gap was almost entirely node count (1.82× vs 1.07×), not per-node cost. Load
  `public/net-weights.json`.
- **Equal *time* is not equal time.** `searchRootTimed` checks its deadline
  only between iterative-deepening passes, so the deeper searcher overshoots
  further: at a nominal 800 ms budget the bitboard backend consumes ~1.8× the
  wall clock chessjs does. Any equal-time A/B between unequal-speed engines is
  biased toward the faster one until that is fixed.

## The scripts

| script | measures | status |
|---|---|---|
| `bench1_movegen.ts` | bitboard `generateLegal` vs `chess.js`, plus legal-move-set and perft(3) correctness gates | ok |
| `bench2_search.ts` | TT+ID vs no-TT; bitboard vs chessjs backend at equal depth | ok |
| `bench3_nnue.ts` | per-eval cost (PST / from-scratch NNUE / accumulator) and whole-search PST vs NNUE | ok |
| `bench4_selfplay.ts` | end-to-end self-play ms/move, both backends — the data-generation path | ok |
| `bench5_equaltime.ts` | depth reached under a fixed wall-clock budget | ok |
| `bench6_depth5.ts` | backend speedup trend across depths 3–5, fixed corpus | ok |
| `bench7_overshoot.ts` | deadline-overshoot fairness across backends and evals | ok |
| `bench_layer2.ts` | `h1` sparsity after clipped ReLU; per-eval allocation cost | ok |
| `bench_nnue_split.ts` | `applyAccum` vs `evalAcc` split inside one incremental eval | ok |
| `bench_width.ts` | whether NNUE eval is memory-bound on `Float64Array` weight width | ok |

Every script here builds and runs as-is. If one stops doing so after an engine
refactor, fix it or delete it — do not leave a broken benchmark sitting in the
table, because a benchmark that cannot run still looks authoritative.

## Maintenance

Nothing here is typechecked: `tsconfig.app.json` includes only `src` and
`tsconfig.node.json` only `vite.config.ts`, so `npm run build` will not tell
you when these break. They do get linted (`npm run lint` covers the repo). A
script that imports engine internals will eventually break on a refactor —
that is expected wear, not a mystery. Fix it, or delete it and keep its
conclusion in this file, as was done for the Zobrist benchmark above.

Quick check that they all still bundle:

```bash
for f in bench/bench*.ts; do
  npx esbuild "$f" --bundle --platform=node --format=esm --target=node20 \
    --outfile=/dev/null >/dev/null 2>&1 && echo "ok   $f" || echo "FAIL $f"
done
```
