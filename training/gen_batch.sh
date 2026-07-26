#!/usr/bin/env bash
# Generate a batch of labelled positions by sharding gen.ts across cores.
#
# gen.ts is bundled once with esbuild and run under plain `node`, NOT vite-node:
# eight concurrent vite-node processes each spin up a Vite server and transform
# the whole import graph, which under core contention never even reaches the
# generator. A one-shot esbuild bundle starts in ~50ms per process instead.
# `esbuild` itself must be marked --external: gen.ts now imports SearchWorkerPool
# (for seeded self-play's per-ply timeout), which needs the real `esbuild`
# package resolvable at runtime to bundle its own inner search worker — see
# augment_batch.sh, which hit this same issue first.
#
# Each shard is an independent self-play run with its own seed, writing its own
# gzip file; the Python side reads the whole training/data/ directory and dedups
# on load.
#
# Usage: gen_batch.sh <total_positions> <depth> <n_shards> <cap> <seed_frac> <out_prefix> <seed_base>
#
# <seed_frac> (default 0) is gen.ts's --seed-frac: the fraction of games that
# start from a sampled material-rich position (nnue-data-coverage-spec.md
# mechanism 1) instead of START_FEN. <out_prefix> (default "shard") lets a
# seeded batch write to training/data/seeded-shard-*.jsonl.gz instead of
# colliding with a prior natural-only run's shard-*.jsonl.gz. <seed_base>
# (default 1000) must differ across runs writing into the *same* eventual
# training/data/ directory (e.g. a second scale-up round) — otherwise the new
# shards reproduce the same seeded RNG streams as an earlier run and add
# near-duplicate games instead of new diversity.
set -euo pipefail
cd "$(dirname "$0")/.."

TOTAL="${1:-100000}"
DEPTH="${2:-3}"
SHARDS="${3:-8}"
CAP="${4:-120}"
SEED_FRAC="${5:-0}"
OUT_PREFIX="${6:-shard}"
SEED_BASE="${7:-1000}"
# Where the shards land. Defaults to the shared training/data/ that the Python
# side reads; override so a self-contained experiment (scale_loop.sh) keeps its
# shards out of the main dataset entirely, rather than writing here and moving
# them afterwards -- a run that dies mid-batch would otherwise strand shards in
# training/data/ where the next training run would silently pick them up.
DATA_DIR="${DATA_DIR:-training/data}"
PER=$(( (TOTAL + SHARDS - 1) / SHARDS ))
BUNDLE="training/gen.bundle.mjs"
mkdir -p "$DATA_DIR" "$DATA_DIR/logs"

echo "bundling gen.ts ..."
npx esbuild training/gen.ts --bundle --platform=node --format=esm --target=node20 \
  --external:esbuild --outfile="$BUNDLE" >/dev/null

echo "generating ${TOTAL} positions at depth ${DEPTH} across ${SHARDS} shards into ${DATA_DIR} (${PER} each, seed-frac ${SEED_FRAC}, seed-base ${SEED_BASE})"
pids=()
for i in $(seq 1 "$SHARDS"); do
  seed=$(( SEED_BASE + i ))
  out="${DATA_DIR}/${OUT_PREFIX}-${i}.jsonl.gz"
  log="${DATA_DIR}/logs/${OUT_PREFIX}-${i}.log"
  node "$BUNDLE" \
    --positions "$PER" --depth "$DEPTH" --seed "$seed" --cap "$CAP" \
    --seed-frac "$SEED_FRAC" --out "$out" \
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
  tail -n 8 "${DATA_DIR}/logs/${OUT_PREFIX}-${i}.log"
done

total=$(gunzip -c "$DATA_DIR"/${OUT_PREFIX}-*.jsonl.gz | wc -l)
echo "=== done: ${total} positions written across ${SHARDS} shards (fail=${fail}) ==="
exit "$fail"
