# Evolutionary Chess

**A chess variant where pieces evolve mid-game. No starting pieces, you earn them.**

Related [blog post](https://penkovsky.com/post/evochess).

[Play in your browser](https://penkovsky.github.io/evochess/). No install. No account.


## Rules

"You shall start with only Pawns and a King. The pieces shall be earned."

"Every 3 Pawn moves shall earn a Knight or a Bishop for any Pawn."

"Every 3 minor moves shall earn a Rook for any minor."

"Rights shall keep until spent. One per turn."

"Promote at once or wait you can."

"5 moves a Rook shall last then fall to a minor. Never to rise again."

"A Pawn on the last rank shall promote as in chess."

"Castle shall you not."

Complete evochess rules are [here](./rules.txt).


## Stack

- [react-chessboard](https://github.com/Clariity/react-chessboard) for the UI
- Depth-limited minimax with alpha-beta pruning for the AI opponent
  (`src/evochess/ai.ts`).
- Game state persisted to `localStorage`, so a page refresh resumes the
  current game.
- Initial version used [chess.js](https://github.com/jhlywa/chess.js) for base chess legality.


## Dev

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


## Clips (optional)

Renders a game or a position as a 1080x1920 mp4.

```bash
npx esbuild scripts/makeClip.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=scripts/makeClip.bundle.mjs
node scripts/makeClip.bundle.mjs clips/tutorial-2.json
```

Needs `ffmpeg` on the path. Starts and stops a dev server itself, unless
`--base <url>` points at one. Output lands in `clips/out/`.

One JSON manifest per clip, in `clips/`. `clips/game2.json` is a logged game
with an eval bar, `clips/tutorial-2.json` a short mate from a set-up position:

```json
{
  "out": "out/game2.mp4",
  "moves": "../data/games/game2.txt",
  "evals": "../data/games/game2-annotated.tsv",
  "evalColumn": "net-relab4-d5.search",
  "captions": { "26": "The knight evolved to a rook, with check." },
  "speed": 1.4,
  "speeds": { "40-43": 0.7 },
  "titleCard": "A knight that arrives as a rook",
  "endCard": "evochess.org"
}
```

A share link can stand in for the start position and the moves, so a clip of
something you hit in the app is a paste:

```json
{ "out": "out/that-game.mp4", "p": "https://evochess.org/?p=AQEI_wAA..." }
```

If the link carries history it brings the move line with it. A link shared
while browsing starts the clip at that ply; a whole-game link starts at the
opening.

Pictures can be cut in as full-screen cards, anchored to a ply:

```json
"images": [ { "src": "img/cat-shock.png", "at": 2, "when": "after" } ]
```

`"titleGradient": true` and `"endGradient": true` put a generated colour
background behind the two cards, `"titleGlyph": "♟"` with an optional
`"titleGlyphColor"` sets a large glyph under the title, and `"logo": true`
brands the end and image cards with the site mark.

`node scripts/gradientSheet.bundle.mjs 100` writes `clips/out/gradients.html`,
a sheet of numbered gradient swatches to pick a seed from.

Every field, the pacing rules and the animation are in
`docs/clip-tool-spec.md`.


## A note on the name

I would like to credit Hafsteinn Kjartansson's
[Evochess](https://www.chessvariants.com/rules/evochess) (2010). A 12x12 board
with non-standard pieces. There pieces promote not once, but twice.

There also exists a variant from 2001, Jason D. Wittman's
[Evolution Chess](https://www.chessvariants.com/42.dir/evolution-chess.html).
It was created for the 42 Squares Chess Variant Contest. Every piece evolves a
step each time it moves. Knight, bishop, rook, queen.

I invented [my variant](https://www.chessvariants.com/rules/echess)
in the train in 2016, just after New Year's Eve. I was blissfully unaware of the
existence of other variants with the same name.


## NNUE Training (optional)

By default, the engine uses Piece-Square Table (PST), a hand-crafted positional
evaluation technique. Alternatively, it also supports Efficiently‑Updated
Neural Networks (NNUE, written backwards).

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

