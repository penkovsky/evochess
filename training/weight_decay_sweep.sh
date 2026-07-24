#!/usr/bin/env bash
# Sweep --weight-decay values and compare them by equal-time match strength,
# not validation loss.
#
# Why not val loss: weight decay pulls weights toward zero as part of the
# optimizer step, so it shrinks the net's effective capacity - a lower val
# loss at one decay value and a lower val loss at another aren't measuring
# directly comparable quantities (the only reliable comparison is the actual
# equal-time match result). Every match runs serially, never concurrently, so
# wall-clock search quality stays comparable across candidates.
#
# Usage: weight_decay_sweep.sh "<weight decay values>" [data...] [epochs] [games] [time_ms]
#
#   <weight decay values>  space-separated, quoted as one argument,
#                          e.g. "0.0 1e-5 1e-4 1e-3"
#   [data...]              shard files/dirs for --data, quoted as one argument
#                          (default: "training/data")
#   [epochs]               training epochs per candidate (default: 20)
#   [games]                match games per candidate (default: 100)
#   [time_ms]              ms per move in the match (default: 200)
#
# Example:
#   ./training/weight_decay_sweep.sh "0.0 1e-5 1e-4 1e-3 1e-2"
#   ./training/weight_decay_sweep.sh "0.0 1e-4" "training/data" 5 100 200
#
# Training is fast (minutes) on this project's dataset sizes; the matches are
# the expensive part (~55-90 min each, isolated, serial by design) - budget
# roughly (games/100 * 90min) * (number of weight-decay values) and run
# unattended.
set -euo pipefail
cd "$(dirname "$0")/.."

DECAYS="${1:?usage: weight_decay_sweep.sh \"<weight decay values>\" [data] [epochs] [games] [time_ms]}"
DATA="${2:-training/data}"
EPOCHS="${3:-20}"
GAMES="${4:-100}"
TIME_MS="${5:-200}"

CKPT_DIR="training/checkpoints"
LOG_DIR="$CKPT_DIR/weight-decay-sweep"
mkdir -p "$LOG_DIR"

echo "bundling match.ts ..."
npx esbuild training/match.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=training/match.bundle.mjs >/dev/null

for wd in $DECAYS; do
  echo
  echo "=== weight_decay=${wd}: training (${EPOCHS} epochs) ==="
  ckpt="$CKPT_DIR/net-wd${wd}.pt"
  weights="$CKPT_DIR/net-wd${wd}-weights.json"
  # shellcheck disable=SC2086
  python3 -m training.nnue.train --data $DATA --epochs "$EPOCHS" --weight-decay "$wd" \
    --out "$ckpt" 2>&1 | tee "$LOG_DIR/train-wd${wd}.log" | tail -3

  echo "=== weight_decay=${wd}: exporting weights ==="
  python3 -m training.nnue.export --checkpoint "$ckpt" --out "$weights"

  echo "=== weight_decay=${wd}: matching (${GAMES} games, ${TIME_MS}ms/move, isolated) ==="
  node training/match.bundle.mjs --games "$GAMES" --time "$TIME_MS" --weights "$weights" \
    > "$LOG_DIR/match-wd${wd}.log" 2>&1
  tail -5 "$LOG_DIR/match-wd${wd}.log"
done

echo
echo "=== summary ==="
printf "%-14s %-10s %-20s %s\n" "weight_decay" "score" "elo" "record"
for wd in $DECAYS; do
  log="$LOG_DIR/match-wd${wd}.log"
  score=$(grep -oP 'score \K[0-9.]+(?=%)' "$log" || echo "?")
  elo=$(grep -oP 'elo \(net\):\s+\K.*' "$log" || echo "?")
  record=$(grep -oP 'result \(net\):\s+\K\+[0-9]+ -[0-9]+ =[0-9]+' "$log" || echo "?")
  printf "%-14s %-10s %-20s %s\n" "$wd" "${score}%" "$elo" "$record"
done
