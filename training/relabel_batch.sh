#!/usr/bin/env bash
# Relabel an existing dataset at a deeper search depth, per
# docs/nnue-pst-relabel-spec.md, by sharding relabel.ts across cores. Mirrors
# gen_batch.sh/augment_batch.sh.
#
# relabel.ts is bundled once with esbuild and run under plain `node`, NOT
# vite-node, for the same reason the other batch scripts do: concurrent
# vite-node processes each spin up a Vite server, which never even reaches
# the work under core contention. `esbuild` itself is marked external so the
# per-position search-timeout worker (searchWorker.ts) can still bundle
# itself at runtime — see augment_batch.sh's comment for the full story.
#
# Every shard reads the *entire* input directory but only searches the 1/N of
# positions that hash to its shard index (relabel.ts partitions by
# stateKey(), not by input file, so shards stay balanced regardless of how
# the input happens to be split). Each shard writes its own output file;
# concatenated, they cover every input position exactly once, each with
# either a freshly-searched score or (on a per-position search timeout) its
# original score, per the spec's keep-old-score-on-timeout policy.
#
# Usage: relabel_batch.sh <in_dir> <out_dir> <depth> <n_shards> [weights_path] [timeout_ms] [seed] [backend]
#
# No <weights_path> (the default) is this spec's mode: PST-only leaf eval,
# no NNUE weights loaded. Passing one switches to net-as-leaf scoring
# (nnue-iterative-relabel-spec.md's mode) — see relabel.ts's docstring for
# why that path skips the worker pool.
#
# <backend> (default "auto", relabel.ts's own default) is now "bitboard" for
# both modes — ~17-20× the "chessjs" backend's throughput at equal depth
# (other_docs/bitboard-search-memo.md), the whole reason a depth-5 pass over
# hundreds of thousands of positions is tractable at all. It once applied
# only to PST runs because bitboard couldn't evaluate with the net; the
# incremental accumulator removed that limit, so <weights_path> runs get the
# same speedup. Pass "chessjs" explicitly to force the exact ai.ts eval
# instead, e.g. to compare bitboard- and chessjs-labeled subsets.
set -euo pipefail
cd "$(dirname "$0")/.."

IN_DIR="${1:?usage: relabel_batch.sh <in_dir> <out_dir> <depth> <n_shards> [weights_path] [timeout_ms] [seed] [backend]}"
OUT_DIR="${2:?usage: relabel_batch.sh <in_dir> <out_dir> <depth> <n_shards> [weights_path] [timeout_ms] [seed] [backend]}"
DEPTH="${3:-5}"
SHARDS="${4:-8}"
WEIGHTS="${5:-}"
TIMEOUT_MS="${6:-15000}"
SEED="${7:-1}"
BACKEND="${8:-auto}"
BUNDLE="training/relabel.bundle.mjs"
mkdir -p "$OUT_DIR" "$OUT_DIR/logs"

echo "bundling relabel.ts ..."
npx esbuild training/relabel.ts --bundle --platform=node --format=esm --target=node20 \
  --external:esbuild --outfile="$BUNDLE" >/dev/null

WEIGHTS_ARGS=()
if [ -n "$WEIGHTS" ]; then
  WEIGHTS_ARGS=(--weights "$WEIGHTS")
  echo "relabeling ${IN_DIR} at depth ${DEPTH} across ${SHARDS} shards, net-as-leaf (${WEIGHTS}), backend ${BACKEND}"
else
  echo "relabeling ${IN_DIR} at depth ${DEPTH} across ${SHARDS} shards, PST-only leaf (no weights), backend ${BACKEND}"
fi

pids=()
for i in $(seq 0 $((SHARDS - 1))); do
  out="${OUT_DIR}/relabel-shard-${i}.jsonl.gz"
  log="${OUT_DIR}/logs/relabel-shard-${i}.log"
  node "$BUNDLE" \
    --in "$IN_DIR" --out "$out" --depth "$DEPTH" --seed "$SEED" \
    --shards "$SHARDS" --shard-index "$i" --timeout-ms "$TIMEOUT_MS" --backend "$BACKEND" \
    "${WEIGHTS_ARGS[@]}" \
    >"$log" 2>&1 &
  pids+=($!)
done

fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done

echo "=== per-shard summaries ==="
for i in $(seq 0 $((SHARDS - 1))); do
  echo "--- shard ${i} ---"
  tail -n 6 "${OUT_DIR}/logs/relabel-shard-${i}.log"
done

in_total=$(gunzip -cf "$IN_DIR"/*.jsonl.gz "$IN_DIR"/*.jsonl 2>/dev/null | wc -l)
out_total=$(gunzip -c "${OUT_DIR}"/relabel-shard-*.jsonl.gz | wc -l)
echo "=== done: ${in_total} input positions, ${out_total} relabeled positions written across ${SHARDS} shards (fail=${fail}) ==="
if [ "$in_total" -ne "$out_total" ]; then
  echo "WARNING: input/output position counts differ — check for a partitioning bug" >&2
fi
exit "$fail"
