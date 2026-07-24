#!/usr/bin/env bash
# Generate a batch of material-augmentation positions (nnue-data-coverage-spec.md
# mechanism 2) by sharding augment.ts across cores. Mirrors gen_batch.sh.
#
# augment.ts is bundled once with esbuild and run under plain `node`, NOT
# vite-node, for the same reason gen_batch.sh does this: eight concurrent
# vite-node processes each spin up a Vite server and transform the whole
# import graph, which under core contention never even reaches the generator.
# `esbuild` itself is marked external (--external:esbuild) and the bundle is
# written inside the repo tree, so Node's own module resolution can still find
# it in node_modules at runtime — augment.ts bundles a second, inner worker
# script (searchWorker.ts) via esbuild's JS API for its per-position timeout,
# and that only works if `esbuild` is actually resolvable, not inlined.
#
# Each shard is an independent run with its own seed, writing its own gzip
# file; the Python side reads the whole training/data/ directory and dedups
# on load.
#
# Usage: augment_batch.sh <total_positions> <depth> <n_shards> <timeout_ms> <out_prefix> <seed_base>
#
# <out_prefix> (default "augment-shard") and <seed_base> (default 2000) exist
# for the same reason gen_batch.sh's do: a second scale-up round needs a
# different prefix so its files don't overwrite an earlier round's when
# merged into the same training/data/ directory, and a different seed base
# so it actually samples new positions instead of reproducing the old run's.
set -euo pipefail
cd "$(dirname "$0")/.."

TOTAL="${1:-30000}"
DEPTH="${2:-3}"
SHARDS="${3:-8}"
TIMEOUT_MS="${4:-4000}"
OUT_PREFIX="${5:-augment-shard}"
SEED_BASE="${6:-2000}"
PER=$(( (TOTAL + SHARDS - 1) / SHARDS ))
BUNDLE="training/augment.bundle.mjs"
mkdir -p training/data training/data/logs

echo "bundling augment.ts ..."
npx esbuild training/augment.ts --bundle --platform=node --format=esm --target=node20 \
  --external:esbuild --outfile="$BUNDLE" >/dev/null

echo "generating ${TOTAL} augmented positions at depth ${DEPTH} across ${SHARDS} shards (${PER} each, seed-base ${SEED_BASE})"
pids=()
for i in $(seq 1 "$SHARDS"); do
  seed=$(( SEED_BASE + i ))
  out="training/data/${OUT_PREFIX}-${i}.jsonl.gz"
  log="training/data/logs/${OUT_PREFIX}-${i}.log"
  node "$BUNDLE" \
    --positions "$PER" --depth "$DEPTH" --seed "$seed" --timeout-ms "$TIMEOUT_MS" --out "$out" \
    >"$log" 2>&1 &
  pids+=($!)
done

fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done

echo "=== per-shard summaries ==="
for i in $(seq 1 "$SHARDS"); do
  echo "--- shard ${i} ---"
  tail -n 8 "training/data/logs/${OUT_PREFIX}-${i}.log"
done

total=$(zcat training/data/${OUT_PREFIX}-*.jsonl.gz | wc -l)
echo "=== done: ${total} augmented positions written across ${SHARDS} shards (fail=${fail}) ==="
exit "$fail"
