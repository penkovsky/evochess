# EvoChess

**You start with only pawns and kings, and your army evolves out of pawn activity**.

Play vs Human or AI.
NNUE engine was trained from self-play because EvoChess is a variant that has no
existing engine, no book, no corpus.

Written in TypeScript/React. All game logic (rules engine + AI) runs
client-side; there is no server.

[Play it in your browser](https://penkovsky.github.io/evochess/). No install, no signup.

## Rules in 60 seconds

Each side starts with 8 pawns and a king. That is all. There are no queens,
rooks, knights, or bishops on the board. You grow your army by playing.

**Pawns become minor pieces.** Every 3 pawn moves earn you one promotion
right. Spend it to turn the pawn that just moved into a knight or a bishop.

**Minor pieces become rooks.** Every 3 minor piece moves earn you one more
promotion right. Spend it to turn the minor piece that just moved into a rook.

**Rights are saved up.** You never have to spend one right away. But you can
only spend it on the piece that just moved. A pawn right needs a pawn move. A
minor right needs a minor piece move. One promotion per move, no more.

**Rooks run out.** Every rook has 5 charges. Each rook move spends one. At 0
charges the rook downgrades on the spot into a knight or a bishop. That piece
can never become a rook again. So a rook is a burst of power you time, not a
piece you keep.

Everything else is normal chess. Same moves, same checks, same mates. En
passant works. A pawn reaching the 8th rank promotes as usual, and that is
still obligatory. Castling does not exist.

Complete EvoChess rules are [here](./rules.txt).

## Stack

- [react-chessboard](https://github.com/Clariity/react-chessboard) for the UI
- Depth-limited minimax with alpha-beta pruning for the AI opponent
  (`src/evochess/ai.ts`).
- Game state persisted to `localStorage`, so a page refresh resumes the
  current game.
- Initial version used [chess.js](https://github.com/jhlywa/chess.js) for base chess legality.

## Development

```bash
npm install
npm run dev      # start dev server
npm test         # run the rules-engine test suite (vitest)
npm run test:e2e # run the e2e suite (playwright, auto-starts the dev server)
npm run build    # typecheck + production build
```

## Deployment

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml`.

## NNUE Training (optional)

By default, the engine uses Piece-Square Table (PST), a hand-crafted positional
evaluation technique. Alternatively, it also supports Efficiently‑Updated
Neural Networks (called NNUE due to some Japanese translation issues).
This section describes how to train such a neural network.

### Step 1 - generate (or relabel) data

`training/scale_loop.sh` is the maintained way to generate self-play data. It
runs the natural/augmented/seeded generation mix in the right composition,
then trains and and matches each doubling round automatically:

```bash
training/scale_loop.sh [base_positions] [max_rounds] [games] [depth] [shards]
```

Data lands under `training/data-scale/`, checkpoints under
`training/checkpoints/scale-r<N>*`, and a summary accumulates in
`training/data-scale/scale-log.tsv`. It's resumable: rerun it and it picks up
from the last completed round.

To relabel existing data instead of generating more:

```bash
training/relabel_batch.sh training/data training/data-relabel-pst5 5
```

Steps 1a-4 below are the manual train/match flow, used for the relabeled
data path above. `scale_loop.sh` already runs the equivalent steps for you
when generating new data.

### Step 1a - retrain on the relabeled data

```bash
python -m training.nnue.train \
  --data training/data-relabel-pst5 --epochs 20 \
  --out training/checkpoints/net-relabel-pst5.pt
```

Export to the JSON format the JS side loads:

```bash
python -m training.nnue.export \
  --checkpoint training/checkpoints/net-relabel-pst5.pt \
  --out training/checkpoints/net-relabel-pst5-weights.json
```

### Step 2 - ladder gate

```bash
npx esbuild training/ladder.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=training/ladder.bundle.mjs
node training/ladder.bundle.mjs --weights training/checkpoints/net-relabel-pst5-weights.json
```

### Step 3 - match vs. material+PST:

```bash
npx esbuild training/match.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=training/match.bundle.mjs
node training/match.bundle.mjs --weights training/checkpoints/net-relabel-pst5-weights.json --games 100
```

### Step 4 - match vs. another net (optional)

Pass `--opponent-weights` to play the challenger against a second checkpoint
instead of material+PST, e.g. to check a relabeled net against the net it's
meant to replace:

```bash
node training/match.bundle.mjs \
  --weights training/checkpoints/net-relabel-pst5-weights.json \
  --opponent-weights training/checkpoints/net-weights.json --games 100
```

