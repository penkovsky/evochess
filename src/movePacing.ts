// A shallow Easy move lands almost at once, which is a tell. Pad it out to
// the time a real search takes, so every move arrives the same way.
const TARGET_MIN_MS = 380;
const TARGET_MAX_MS = 560;

/** Pads a move up to a target total, so shallow and deep moves match. */
export function paceDelayMs(elapsedMs: number): number {
  const target = TARGET_MIN_MS + Math.random() * (TARGET_MAX_MS - TARGET_MIN_MS);
  return Math.max(0, target - elapsedMs);
}
