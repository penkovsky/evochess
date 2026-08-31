// Replays a logged game (SAN as printed by the match harness) and prints a
// `?p=` payload per ply, so a screenshot can be taken of any position in it.
//
//   npx esbuild scripts/gameToShareLinks.ts --bundle --platform=node --format=esm \
//     --outfile=scripts/gameToShareLinks.bundle.mjs
//   node scripts/gameToShareLinks.bundle.mjs data/games/game2.txt

import { EvoChessGame } from "../src/evochess/game";
import { encodeShareLink } from "../src/evochess/shareLink";
import { playSan, readMoveTokens } from "./lib/replay";

const file = process.argv[2] ?? "data/games/game2.txt";
const tokens = readMoveTokens(file);

const game = new EvoChessGame();
console.log(`ply 0\t${encodeShareLink(game)}`);
tokens.forEach((san, i) => {
  playSan(game, san);
  console.log(`ply ${i + 1}\t${san}\t${game.turn} to move\t${encodeShareLink(game)}`);
});
