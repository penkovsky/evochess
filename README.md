# EvoChess (web)

A standalone, backend-free browser port of [EvoChess](./rules.txt) — a chess
variant where the game starts with only Pawns and Kings, and pieces evolve
onto the board over time via accumulated promotion rights.

This is a TypeScript/React port of the reference Python implementation. All
game logic (rules engine + minimax AI) runs client-side; there is no server.

## Rules

See [`rules.txt`](./rules.txt) for the full rule text.

## Stack

- [chess.js](https://github.com/jhlywa/chess.js) for base chess legality
- [react-chessboard](https://github.com/Clariity/react-chessboard) for the UI
- Depth-limited minimax with alpha-beta pruning for the AI opponent
  (`src/evochess/ai.ts`)
- Game state persisted to `localStorage`, so a page refresh resumes the
  current game

## Development

```bash
npm install
npm run dev      # start dev server
npm test         # run the rules-engine test suite (vitest)
npm run build    # typecheck + production build
```

## Deployment

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml`. Enable Pages (Source: GitHub Actions) in the
repo settings for this to take effect.
