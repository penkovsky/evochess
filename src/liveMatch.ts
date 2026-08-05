/**
 * Live match over a link (docs/live-match.md, M1).
 *
 * Moves only over the wire: both clients run the engine, the backend knows no
 * chess. The match id in the link is the read capability; the per-seat token
 * kept here is the write capability and never appears in a URL. Polling, bare
 * `fetch`, same collector and key as `telemetry.ts`.
 */
import { EvoChessGame, type ApplyMoveOptions } from "./evochess/game";
import type { Color, Square } from "chess.js";
import { decodeShareLink } from "./evochess/shareLink";

const SEAT_KEY = "evochess-live-v1";
export const LM_PARAM = "lm";
export const POLL_MS = 1200;

export interface LiveSeat {
  matchId: string;
  seat: Color;
  token: string;
  firstMover: Color;
  startPayload: string | null;
}

export interface LiveMove {
  ply: number;
  from: string;
  to: string;
  opts: ApplyMoveOptions;
}

export interface LiveState {
  status: "waiting" | "live" | "over";
  firstMover: Color;
  startPayload: string | null;
  /** Both seats taken. */
  joined: boolean;
  /** The seat still to be claimed, null once both are. */
  freeSeat: Color | null;
  moves: LiveMove[];
}

/** The match on the board: what it is, plus our seat in it (null = observer). */
export interface LiveView {
  matchId: string;
  status: LiveState["status"];
  firstMover: Color;
  startPayload: string | null;
  joined: boolean;
  freeSeat: Color | null;
  seat: LiveSeat | null;
}

/** Odd plies belong to `firstMover`. The whole turn-ownership rule. */
export function seatForPly(ply: number, firstMover: Color): Color {
  const other: Color = firstMover === "w" ? "b" : "w";
  return ply % 2 === 1 ? firstMover : other;
}

/**
 * Whether the next ply is the local seat's. No match at all answers yes, since
 * then nothing here is in the way. An observer, a match that is over and a
 * browser with no token all answer no. That last one is the whole "the link
 * only reads" rule.
 */
export function canMoveNow(lv: LiveView | null, plies: number): boolean {
  if (!lv) return true;
  if (!lv.seat || lv.status === "over") return false;
  return seatForPly(plies + 1, lv.firstMover) === lv.seat.seat;
}

/**
 * Whether a poll is worth issuing. Nothing can arrive on our own turn, while
 * the tab is hidden, or once the match is over. The exception is a match whose
 * other seat is still empty, where the join is the thing being waited for.
 */
export function shouldPoll(
  lv: LiveView | null,
  plies: number,
  gameOver: boolean,
  hidden: boolean
): boolean {
  if (!lv || hidden || gameOver || lv.status === "over") return false;
  if (!lv.joined) return true;
  return !(lv.seat && seatForPly(plies + 1, lv.firstMover) === lv.seat.seat);
}

/**
 * Rebuilt by allowlist, never by spreading: an unexpected key from the wire is
 * dropped before the engine sees it.
 */
export function sanitizeOpts(raw: unknown): ApplyMoveOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: ApplyMoveOptions = {};
  if (o.forcedPromo === "q" || o.forcedPromo === "r" || o.forcedPromo === "b" || o.forcedPromo === "n")
    out.forcedPromo = o.forcedPromo;
  if (o.minorPromo === "n" || o.minorPromo === "b") out.minorPromo = o.minorPromo;
  if (o.rookPromo === true) out.rookPromo = true;
  if (o.downgradeTo === "n" || o.downgradeTo === "b") out.downgradeTo = o.downgradeTo;
  return out;
}

// ------------------------------------------------------------------ transport

class Retryable extends Error {}

/** One `security definer` call. Throws `Retryable` for anything worth retrying. */
async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  // Read per call rather than at module load, so a test can vary the config.
  const endpoint = import.meta.env.VITE_TELEMETRY_URL ?? "";
  const key = import.meta.env.VITE_TELEMETRY_KEY ?? "";
  if (!endpoint || !key) throw new Error("live match not configured");
  let res: Response;
  try {
    res = await fetch(`${endpoint}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Retryable("network");
  }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new Retryable(`http ${res.status}`);
    // PostgREST puts the reason in the body, and a 404 here means the function
    // is missing or not granted to `anon` rather than the route being wrong.
    const detail = await res.text().catch(() => "");
    throw new Error(`${fn}: http ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  return res.json();
}

export async function lmCreate(
  startPayload: string | null,
  firstMover: Color,
  creatorSeat: Color
): Promise<LiveSeat> {
  const row = (await rpc("lm_create", {
    p_start_payload: startPayload,
    p_first_mover: firstMover,
    p_creator_seat: creatorSeat,
  })) as { match_id: string; token: string };
  return { matchId: row.match_id, seat: creatorSeat, token: row.token, firstMover, startPayload };
}

/**
 * What a match looks like the instant it is created: no moves yet, whatever
 * position it was created from as the base, and the other seat free. The
 * creator puts this on the board through the same path the joiner uses, so both
 * sides play a game whose move list starts empty and whose first send is ply 1.
 */
export function newMatchState(startPayload: string | null, firstMover: Color, creatorSeat: Color): LiveState {
  return {
    status: "waiting",
    firstMover,
    startPayload,
    joined: false,
    freeSeat: creatorSeat === "w" ? "b" : "w",
    moves: [],
  };
}

/** Never called on page load: the link only reads until someone acts. */
export async function lmJoin(matchId: string, state: LiveState): Promise<LiveSeat> {
  const row = (await rpc("lm_join", { p_match: matchId })) as { seat: Color; token: string };
  return {
    matchId,
    seat: row.seat,
    token: row.token,
    firstMover: state.firstMover,
    startPayload: state.startPayload,
  };
}

/** The only read path. Null for an unknown id, or any failure. */
export async function lmFetch(matchId: string, sincePly: number): Promise<LiveState | null> {
  let row: unknown;
  try {
    row = await rpc("lm_fetch", { p_match: matchId, p_since: sincePly });
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (r.status !== "waiting" && r.status !== "live" && r.status !== "over") return null;
  if (r.first_mover !== "w" && r.first_mover !== "b") return null;
  const moves: LiveMove[] = [];
  for (const m of Array.isArray(r.moves) ? r.moves : []) {
    const x = m as Record<string, unknown>;
    if (typeof x.ply !== "number" || typeof x.from !== "string" || typeof x.to !== "string") return null;
    moves.push({ ply: x.ply, from: x.from, to: x.to, opts: sanitizeOpts(x.opts) });
  }
  return {
    status: r.status,
    firstMover: r.first_mover,
    startPayload: typeof r.start_payload === "string" ? r.start_payload : null,
    joined: r.joined === true,
    freeSeat: r.free_seat === "w" || r.free_seat === "b" ? r.free_seat : null,
    moves,
  };
}

/**
 * Sends one move, off the move path: the board never waits on the network.
 * Retries with backoff; a ply conflict is not retried, since it cannot clear.
 */
export async function sendMove(
  seat: LiveSeat,
  ply: number,
  from: string,
  to: string,
  opts: ApplyMoveOptions,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rpc("lm_play", {
        p_match: seat.matchId,
        p_token: seat.token,
        p_ply: ply,
        p_from: from,
        p_to: to,
        p_opts: opts,
      });
      return true;
    } catch (e) {
      if (!(e instanceof Retryable)) return false;
      await sleep(300 * 2 ** attempt);
    }
  }
  return false;
}

// ------------------------------------------------------------------ replay

/**
 * The whole match from its start position. Used by the `?lm=` bootstrap, by a
 * reload, and by the resync a gap or a rejected move triggers.
 *
 * `snapshots` holds the position before each move, which is what `historyRef`
 * wants. Null means the payload or the move list would not replay, so the match
 * has diverged and there is nothing to put on the board.
 */
export function replay(
  startPayload: string | null,
  moves: LiveMove[]
): { game: EvoChessGame; snapshots: EvoChessGame[] } | null {
  let game: EvoChessGame;
  if (startPayload) {
    const shared = decodeShareLink(startPayload);
    if (!shared.ok || !shared.legal) return null;
    game = shared.game;
  } else {
    game = new EvoChessGame();
  }
  const snapshots: EvoChessGame[] = [];
  for (const m of moves) {
    snapshots.push(game.copy());
    try {
      game.applyMove(m.from as Square, m.to as Square, m.opts);
    } catch {
      return null;
    }
  }
  return { game, snapshots };
}

// ------------------------------------------------------------------ seat store

/** The seat for `matchId`, if this browser holds one. */
export function loadSeat(matchId: string): LiveSeat | null {
  try {
    const raw = localStorage.getItem(SEAT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as LiveSeat;
    return s && s.matchId === matchId && typeof s.token === "string" ? s : null;
  } catch {
    return null;
  }
}

export function saveSeat(seat: LiveSeat) {
  try {
    localStorage.setItem(SEAT_KEY, JSON.stringify(seat));
  } catch {
    /* a full or blocked store costs the seat, not the game */
  }
}

export function clearSeat() {
  try {
    localStorage.removeItem(SEAT_KEY);
  } catch {
    /* ignore */
  }
}

export function readMatchParam(search: string): string | null {
  const v = new URLSearchParams(search).get(LM_PARAM);
  return v && v.length > 0 ? v : null;
}

/** The invite link: the match id and nothing else. */
export function inviteUrl(matchId: string, base = window.location.href): string {
  const url = new URL(base);
  url.search = "";
  url.searchParams.set(LM_PARAM, matchId);
  return url.toString();
}
