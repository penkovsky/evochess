/**
 * The move log as pasteable text: one numbered pair per line, the way a game
 * is written down. Newline-separated rather than one long run, so it stays
 * readable in a chat message or a note.
 */
export function formatMoveLog(moveLog: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < moveLog.length; i += 2) {
    const black = moveLog[i + 1];
    lines.push(`${i / 2 + 1}. ${moveLog[i]}${black ? ` ${black}` : ""}`);
  }
  return lines.join("\n");
}
