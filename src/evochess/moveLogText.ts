/**
 * The move log as pasteable text: one numbered pair per line, the way a game
 * is written down. Newline-separated rather than one long run, so it stays
 * readable in a chat message or a note.
 */
export function formatMoveLog(moveLog: string[], blackFirst = false): string {
  if (moveLog.length === 0) return "";
  // A game that opened on a shared position with Black to move has a Black
  // ply first. Black always belongs in the second slot, so the pair is filled
  // out with the usual placeholder for the White move that was never played.
  const plies = blackFirst ? ["...", ...moveLog] : moveLog;
  const lines: string[] = [];
  for (let i = 0; i < plies.length; i += 2) {
    const black = plies[i + 1];
    lines.push(`${i / 2 + 1}. ${plies[i]}${black ? ` ${black}` : ""}`);
  }
  return lines.join("\n");
}
