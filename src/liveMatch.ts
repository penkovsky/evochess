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
/** Consecutive failed polls before the status line says so. About four seconds. */
export const LOST_AFTER_FAILURES = 3;

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
  /** Who has asked for a rematch, by seat. */
  rematchW: boolean;
  rematchB: boolean;
  /** The match this one turned into, once both sides asked. */
  rematchId: string | null;
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
  rematchW: boolean;
  rematchB: boolean;
  rematchId: string | null;
  seat: LiveSeat | null;
  /**
   * The two boards have diverged: a replay failed, or the server refused a move
   * we had already played. Terminal, because nothing here can repair it. Only a
   * new game clears it, since that leaves the match altogether.
   */
  outOfSync: boolean;
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
  if (!lv.seat || lv.status === "over" || lv.outOfSync) return false;
  // Nobody to play against yet, and `lm_play` refuses a move before the second
  // seat is taken. Letting one through would put a move on our board that the
  // server never takes, which is the out-of-sync case.
  if (!lv.joined) return false;
  return seatForPly(plies + 1, lv.firstMover) === lv.seat.seat;
}

/**
 * Whether the rematch offer belongs on the board. A seat of ours, a finished
 * game, and a match that still works.
 *
 * Deliberately blind to whether the board is being browsed. Stepping back
 * through the game just played is the normal thing to do after one, and the
 * offer carries the only sign that the opponent has asked.
 */
export function rematchOffered(lv: LiveView | null, gameOver: boolean): boolean {
  return !!lv?.seat && gameOver && !lv.outOfSync;
}

/** Our own rematch ask, and the opponent's. Neither, for an observer. */
export function rematchAsks(lv: LiveView): { mine: boolean; theirs: boolean } {
  if (!lv.seat) return { mine: false, theirs: false };
  const w = { mine: lv.rematchW, theirs: lv.rematchB };
  return lv.seat.seat === "w" ? w : { mine: w.theirs, theirs: w.mine };
}

/**
 * Whether a poll is worth issuing. Nothing can arrive on our own turn, while
 * the tab is hidden, or once the match is over. The exception is a match whose
 * other seat is still empty, where the join is the thing being waited for.
 *
 * A finished game keeps one thing to wait for: the opponent's rematch ask, and
 * then the match it creates. Once that match exists there is nothing left here.
 */
export function shouldPoll(
  lv: LiveView | null,
  plies: number,
  gameOver: boolean,
  hidden: boolean,
  connectionLost = false
): boolean {
  if (!lv || hidden || lv.outOfSync) return false;
  if (gameOver || lv.status === "over") return !!lv.seat && !lv.rematchId;
  // A lost connection is only cleared by a read that works, so keep reading
  // even on our own turn. Otherwise the warning outlives the outage.
  if (!lv.joined || connectionLost) return true;
  return !(lv.seat && seatForPly(plies + 1, lv.firstMover) === lv.seat.seat);
}

/**
 * A poll's answer folded into the match on screen. Only these three fields
 * come from a poll: the seat and `outOfSync` are ours, and a poll in flight
 * while either changes must not put the old value back.
 */
export function mergeLive(lv: LiveView, state: LiveState): LiveView {
  return {
    ...lv,
    status: state.status,
    joined: state.joined,
    freeSeat: state.freeSeat,
    rematchW: state.rematchW,
    rematchB: state.rematchB,
    rematchId: state.rematchId,
  };
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
  // `lm_play` returns void, which PostgREST answers with an empty body. Parsing
  // it would throw, and a stored move would be reported as a refusal.
  return res.json().catch(() => null);
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
    rematchW: false,
    rematchB: false,
    rematchId: null,
    moves: [],
  };
}

/** A match that came out of a rematch: both seats taken, no moves yet. */
export function rematchState(seat: LiveSeat): LiveState {
  return {
    status: "live",
    firstMover: seat.firstMover,
    startPayload: seat.startPayload,
    joined: true,
    freeSeat: null,
    rematchW: false,
    rematchB: false,
    rematchId: null,
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

/**
 * What a read came back with. `null` is a failure worth retrying, and is what
 * the connection-lost count counts. `"unknown"` is an answer: there is no such
 * match, and retrying will not change that.
 */
export type FetchResult = LiveState | "unknown" | null;

/** The only read path. */
export async function lmFetch(matchId: string, sincePly: number): Promise<FetchResult> {
  let row: unknown;
  try {
    row = await rpc("lm_fetch", { p_match: matchId, p_since: sincePly });
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return "unknown";
  const r = row as Record<string, unknown>;
  if (r.status !== "waiting" && r.status !== "live" && r.status !== "over") return "unknown";
  if (r.first_mover !== "w" && r.first_mover !== "b") return "unknown";
  const moves: LiveMove[] = [];
  for (const m of Array.isArray(r.moves) ? r.moves : []) {
    const x = m as Record<string, unknown>;
    if (typeof x.ply !== "number" || typeof x.from !== "string" || typeof x.to !== "string") return "unknown";
    moves.push({ ply: x.ply, from: x.from, to: x.to, opts: sanitizeOpts(x.opts) });
  }
  return {
    status: r.status,
    firstMover: r.first_mover,
    startPayload: typeof r.start_payload === "string" ? r.start_payload : null,
    joined: r.joined === true,
    freeSeat: r.free_seat === "w" || r.free_seat === "b" ? r.free_seat : null,
    rematchW: r.rematch_w === true,
    rematchB: r.rematch_b === true,
    rematchId: typeof r.rematch_id === "string" ? r.rematch_id : null,
    moves,
  };
}

/**
 * Asks for a rematch, and collects the seat once both sides have. The same call
 * does both: the ask is idempotent, and the next match's token is not something
 * `lm_fetch` will hand out, so this is how each side gets its own.
 *
 * `"asked"` means the ask is in and the opponent has not answered. `null` is a
 * failure worth trying again on the next press or poll.
 */
export async function lmRematch(matchId: string, token: string): Promise<LiveSeat | "asked" | null> {
  let row: unknown;
  try {
    row = await rpc("lm_rematch", { p_match: matchId, p_token: token });
  } catch (e) {
    console.warn("evochess: lm_rematch failed", e);
    return null;
  }
  const r = (row ?? {}) as Record<string, unknown>;
  if (typeof r.match_id !== "string" || typeof r.token !== "string") return "asked";
  if (r.seat !== "w" && r.seat !== "b") return "asked";
  if (r.first_mover !== "w" && r.first_mover !== "b") return "asked";
  return {
    matchId: r.match_id,
    seat: r.seat,
    token: r.token,
    firstMover: r.first_mover,
    startPayload: typeof r.start_payload === "string" ? r.start_payload : null,
  };
}

/** A failure adds one; any answer, including "no such match", clears it. */
export function countFailure(count: number, result: FetchResult): number {
  return result === null ? count + 1 : 0;
}

/** One failed read says nothing. Three in a row are worth telling the player. */
export function isConnectionLost(count: number): boolean {
  return count >= LOST_AFTER_FAILURES;
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
      // The server's reason, which is otherwise lost behind "out of sync".
      if (!(e instanceof Retryable)) {
        console.warn("evochess: lm_play refused", e);
        return false;
      }
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

/** The address bar with the match on it, or off it. */
export function setMatchParam(href: string, matchId: string | null): string {
  const url = new URL(href);
  if (matchId) url.searchParams.set(LM_PARAM, matchId);
  else url.searchParams.delete(LM_PARAM);
  return url.pathname + url.search + url.hash;
}

/** The invite link: the match id and nothing else. */
export function inviteUrl(matchId: string, base = window.location.href): string {
  const url = new URL(base);
  url.search = "";
  url.searchParams.set(LM_PARAM, matchId);
  return url.toString();
}
