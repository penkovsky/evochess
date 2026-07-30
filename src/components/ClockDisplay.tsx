import type { Color } from "chess.js";

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ClockDisplay({
  clock,
  turn,
  gameOver,
}: {
  clock: Record<Color, number>;
  turn: Color;
  gameOver: boolean;
}) {
  return (
    <div className="clocks">
      {(["w", "b"] as Color[]).map((color) => (
        <div
          key={color}
          className={`clock ${!gameOver && turn === color ? "active" : ""} ${clock[color] <= 10 ? "low" : ""}`}
        >
          <span className="clock-label">{color === "w" ? "White" : "Black"}</span>
          <span className="clock-time">{formatClock(clock[color])}</span>
        </div>
      ))}
    </div>
  );
}
