#!/usr/bin/env bash
# The data-scale check from docs/nnue-iterative-relabel-spec.md ("Preconditions"),
# run as a doubling loop: train a net, double the dataset, train again, and
# measure what the extra data actually bought. It answers one question —
#
#   is the net data-limited (more positions still help) or teacher-limited
#   (labels are the ceiling, and relabeling is the lever)?
#
# and stops as soon as the answer is "teacher-limited", so you don't spend
# another night generating data that can't help.
#
# Each round r:
#   1. generate until the set reaches base * 2^r positions
#   2. train on the whole set, export the weights
#   3. gate on the ladder (a failure here means something is wrong, stop)
#   4. match vs material+PST     — a fixed anchor, comparable across rounds
#   5. match vs round r-1's net  — the marginal value of *this* doubling
#   6. stop when that marginal match lands inside its own error bars
#
# The stop rule is step 5's confidence interval containing zero: doubling the
# data no longer beats the previous net by more than noise. That is the plateau
# the spec means by "curve flat", and the point to switch to relabeling.
#
# Why generate rather than subset an existing large set: train.py's --limit
# truncates in *file order* (load_positions breaks once it has N), so a limited
# run reads only the alphabetically-first shards — all augment, no natural or
# seeded. That confounds set size with set composition, which is the one thing
# this experiment must hold constant. Generating each round with the same
# three-way mix keeps composition fixed and only size moving.
#
# Usage: scale_loop.sh [base_positions] [max_rounds] [games] [depth] [shards]
#
#   base_positions  size of round 0 (default 100000)
#   max_rounds      hard ceiling on doublings (default 4 → up to 16x base)
#   games           games per match (default 100; the ±35 Elo noise band in the
#                   spec assumes 100 — fewer widens it and the loop will stop
#                   early on noise alone)
#   depth           generation search depth (default 3)
#   shards          parallel shards per batch (default 8)
#
# Everything lands under training/data-scale/ and training/checkpoints/, and a
# machine-readable summary accumulates in training/data-scale/scale-log.tsv.
#
# Resumable: a round whose checkpoint already exists is skipped, so an
# interrupted run picks up where it left off. Delete the checkpoint to redo one.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-100000}"
MAX_ROUNDS="${2:-4}"
GAMES="${3:-100}"
DEPTH="${4:-3}"
SHARDS="${5:-8}"

EPOCHS="${EPOCHS:-20}"
MATCH_MS="${MATCH_MS:-200}"
DATA_DIR="training/data-scale"
CKPT_DIR="training/checkpoints"
LOG_TSV="${DATA_DIR}/scale-log.tsv"

mkdir -p "$DATA_DIR" "$CKPT_DIR"

count_positions() {
  shopt -s nullglob
  local files=("$DATA_DIR"/*.jsonl.gz)
  shopt -u nullglob
  [ ${#files[@]} -eq 0 ] && { echo 0; return; }
  # Raw record count: train.py dedups and drops untrainable records, so the
  # trained-on total is somewhat lower. Fine for targeting a scale.
  gunzip -c "${files[@]}" | wc -l | tr -d ' '
}

# "+191 ± 201" → "191 201". A CI containing zero means the result is noise.
parse_elo() {
  sed -n 's/^elo (challenger): *\([+-]\{0,1\}[0-9]\{1,\}\) *± *\([0-9]\{1,\}\).*/\1 \2/p' "$1"
}

echo "bundling ladder + match ..."
npx esbuild training/ladder.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=training/ladder.bundle.mjs >/dev/null
npx esbuild training/match.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=training/match.bundle.mjs >/dev/null

if [ ! -f "$LOG_TSV" ]; then
  printf 'round\ttarget\tactual\tckpt\tladder\telo_vs_pst\tband_vs_pst\telo_vs_prev\tband_vs_prev\tverdict\n' >"$LOG_TSV"
fi

prev_weights=""
for r in $(seq 0 $((MAX_ROUNDS - 1))); do
  target=$((BASE * (2 ** r)))
  ckpt="${CKPT_DIR}/scale-r${r}.pt"
  weights="${CKPT_DIR}/scale-r${r}-weights.json"

  echo
  echo "================ round ${r}: target ${target} positions ================"

  current=$(count_positions)
  need=$((target - current))
  if [ "$need" -gt 0 ]; then
    # Equal thirds across the three mechanisms, matching more_data.sh's recipe:
    # natural self-play, material augmentation, seeded self-play. Holding this
    # split fixed is what keeps composition constant as size doubles.
    third=$(( (need + 2) / 3 ))
    # Distinct per round *and* per mechanism: gen_batch.sh warns that reusing a
    # seed base across runs writing into one dataset reproduces the same RNG
    # streams, adding near-duplicate games instead of new diversity.
    seed_base=$((20000 + r * 3000))

    # DATA_DIR sends the batch scripts' output straight here instead of the
    # shared training/data/, so a run that dies mid-batch leaves nothing behind
    # for a later `train.py --data training/data` to pick up by accident.
    echo "--- round ${r}: generating ${need} positions (3 x ${third}) ---"
    DATA_DIR="$DATA_DIR" ./training/gen_batch.sh \
      "$third" "$DEPTH" "$SHARDS" 120 0 "scale-r${r}-nat" "$seed_base"
    DATA_DIR="$DATA_DIR" ./training/augment_batch.sh \
      "$third" "$DEPTH" "$SHARDS" 4000 "scale-r${r}-aug" "$((seed_base + 1000))"
    DATA_DIR="$DATA_DIR" ./training/gen_batch.sh \
      "$third" "$DEPTH" "$SHARDS" 120 0.5 "scale-r${r}-seed" "$((seed_base + 2000))"
  else
    echo "--- round ${r}: already at ${current} positions, no generation needed ---"
  fi

  actual=$(count_positions)
  echo "--- round ${r}: dataset now ${actual} raw records ---"

  if [ -f "$ckpt" ] && [ -f "$weights" ]; then
    echo "--- round ${r}: ${ckpt} exists, skipping train/export (delete it to redo) ---"
  else
    echo "--- round ${r}: training ---"
    python -m training.nnue.train --data "$DATA_DIR" --epochs "$EPOCHS" --out "$ckpt"
    python -m training.nnue.export --checkpoint "$ckpt" --out "$weights"
  fi

  echo "--- round ${r}: ladder gate ---"
  ladder_status=PASS
  if ! node training/ladder.bundle.mjs --weights "$weights"; then
    ladder_status=FAIL
    echo
    if [ "$r" -eq 0 ]; then
      echo "!!! round 0: LADDER FAILED — stopping. There is no previous net to keep."
      echo "    At round 0 this usually means the base size or epoch count is too"
      echo "    small to learn anything, rather than a scaling result."
    else
      echo "!!! round ${r}: LADDER FAILED — stopping. Keep round $((r - 1))'s net."
    fi
    printf '%s\t%s\t%s\t%s\t%s\t\t\t\t\tladder-fail\n' \
      "$r" "$target" "$actual" "$ckpt" "$ladder_status" >>"$LOG_TSV"
    exit 1
  fi

  echo "--- round ${r}: match vs material+PST (${GAMES} games) ---"
  pst_log="${DATA_DIR}/match-r${r}-vs-pst.log"
  node training/match.bundle.mjs --weights "$weights" --games "$GAMES" --time "$MATCH_MS" \
    --seed $((r + 1)) | tee "$pst_log"
  read -r elo_pst band_pst <<<"$(parse_elo "$pst_log")"

  elo_prev=""
  band_prev=""
  verdict="continue"
  if [ -n "$prev_weights" ]; then
    echo "--- round ${r}: match vs round $((r - 1)) (${GAMES} games) ---"
    prev_log="${DATA_DIR}/match-r${r}-vs-r$((r - 1)).log"
    node training/match.bundle.mjs --weights "$weights" --opponent-weights "$prev_weights" \
      --games "$GAMES" --time "$MATCH_MS" --seed $((r + 1)) | tee "$prev_log"
    read -r elo_prev band_prev <<<"$(parse_elo "$prev_log")"

    # Three cases, by where the confidence interval sits relative to zero:
    #   CI contains zero        → plateau: the doubling bought nothing measurable
    #   CI entirely below zero  → regression: more data made it *worse*, which
    #                             is not a plateau and not something to keep
    #                             doubling through — stop and look at why
    #   CI entirely above zero  → still climbing, keep going
    # abs() without bc; Elo is an integer here.
    abs_elo=${elo_prev#[+-]}
    if [ "$abs_elo" -le "$band_prev" ]; then
      verdict="plateau"
    elif [ "${elo_prev#-}" != "$elo_prev" ]; then
      verdict="regression"
    fi
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$r" "$target" "$actual" "$ckpt" "$ladder_status" \
    "${elo_pst:-}" "${band_pst:-}" "${elo_prev:-}" "${band_prev:-}" "$verdict" >>"$LOG_TSV"

  if [ "$verdict" = "regression" ]; then
    echo
    echo "================================================================"
    echo "REGRESSION at round ${r} (${actual} records)."
    echo "  vs round $((r - 1)): ${elo_prev} ± ${band_prev} Elo — significantly worse."
    echo
    echo "More data made the net weaker, with the ladder still passing. That is"
    echo "not a plateau: suspect the new shards (a seed-base collision producing"
    echo "near-duplicates, or a backend/composition change between rounds)"
    echo "before reading it as a real scaling result. Keeping round $((r - 1))'s net."
    echo "================================================================"
    exit 1
  fi

  if [ "$verdict" = "plateau" ]; then
    echo
    echo "================================================================"
    echo "PLATEAU at round ${r} (${actual} records)."
    echo "  vs round $((r - 1)): ${elo_prev} ± ${band_prev} Elo — inside the noise band."
    echo
    echo "Doubling the data stopped paying. The net is teacher-limited, not"
    echo "data-limited: switch to iterative relabeling"
    echo "(docs/nnue-iterative-relabel-spec.md) using ${weights} as round 0."
    echo "================================================================"
    exit 0
  fi

  prev_weights="$weights"
done

echo
echo "================================================================"
echo "Ran ${MAX_ROUNDS} rounds without plateauing — still data-limited."
echo "The curve is still climbing, so more data is still the cheaper lever"
echo "than relabeling. Re-run with a larger max_rounds to keep doubling."
echo "See ${LOG_TSV} for the per-round Elo curve."
echo "================================================================"
