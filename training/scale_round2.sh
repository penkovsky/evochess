#!/usr/bin/env bash
# Round 2 of NNUE training-data generation
set -euo pipefail
cd "$(dirname "$0")/.."

SHARDS="${1:-8}"

if [ ! -d node_modules ]; then
  echo "error: node_modules missing — run 'npm install' first" >&2
  exit 1
fi

echo "=== round 2, phase 1/2: natural self-play (80,000 positions, ${SHARDS} shards) ==="
./training/gen_batch.sh 80000 3 "$SHARDS" 120 0 shard-r2 5000

echo
echo "=== round 2, phase 2/2: material augmentation (60,000 positions, ${SHARDS} shards) ==="
./training/augment_batch.sh 60000 3 "$SHARDS" 4000 augment-shard-r2 6000

echo
echo "=== round 2 complete ==="
natural_total=$(gunzip -c training/data/shard-*.jsonl.gz 2>/dev/null | wc -l)
augment_total=$(gunzip -c training/data/augment-shard-*.jsonl.gz 2>/dev/null | wc -l)
echo "natural (all shard-* files, round 1 + round 2):   ${natural_total}"
echo "augmented (all augment-shard-* files, round 1+2): ${augment_total}"
echo "grand total (raw, pre-dedup): $(( natural_total + augment_total ))"
echo
echo "Copy training/data/ back to the main machine (rsync/scp), then retrain there:"
echo "  python -m training.nnue.train --data training/data --epochs 20 \\"
echo "      --out training/checkpoints/net.pt"
