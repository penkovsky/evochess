/**
 * Offline: read a numbered-SAN move-list file and print a share link with
 * a history block (docs/share-links-spec.md §4.4).
 *
 *   npx esbuild scripts/shareGame.ts --bundle --platform=node --format=esm \
 *     --outfile=scripts/shareGame.bundle.mjs
 *   node scripts/shareGame.bundle.mjs data/games/game1.txt --cursor 11
 */
import { EvoChessGame } from "../src/evochess/game";
import { encodeShareLinkWithHistory, SHARE_PARAM } from "../src/evochess/shareLink";
import { playSan, readMoveTokens } from "./lib/replay";

const DEFAULT_BASE_URL = "https://evochess.org/";

function parseArgs(argv: string[]): { file: string; cursor?: number; base: string } {
  let file: string | undefined;
  let cursor: number | undefined;
  let base = DEFAULT_BASE_URL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cursor") cursor = Number(argv[++i]);
    else if (arg === "--base") base = argv[++i];
    else if (!file) file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!file) throw new Error("usage: shareGame.ts <move-list file> [--cursor N] [--base <url>]");
  return { file, cursor, base };
}

function main(): void {
  const { file, cursor, base } = parseArgs(process.argv.slice(2));

  const game = new EvoChessGame();
  for (const token of readMoveTokens(file)) playSan(game, token);

  const finalCursor = cursor ?? game.moveTokens.length;
  const payload = encodeShareLinkWithHistory(new EvoChessGame(), game.moveTokens, finalCursor);

  const url = new URL(base);
  url.searchParams.set(SHARE_PARAM, payload);
  console.log(url.toString());
}

try {
  main();
} catch (e) {
  console.error(`shareGame: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
