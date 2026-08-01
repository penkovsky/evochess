// Ships the move log of a finished game, and the funnel events, to the
// collector: a hosted Postgres behind a REST API, holding an insert-only key
// that cannot read. Every entry point swallows its own errors: a failure here
// must be invisible to the player.

const ENDPOINT = import.meta.env.VITE_TELEMETRY_URL ?? "";
const ANON_KEY = import.meta.env.VITE_TELEMETRY_KEY ?? "";

const ANON_ID_KEY = "evochess-anon-v1";
const SESSION_ID_KEY = "evochess-session-v1";
const SESSION_START_KEY = "evochess-session-start-v1";
const SESSION_FIRED_PREFIX = "evochess-fired-";
const QUEUE_KEY = "evochess-log-queue-v1";
const OFF_KEY = "evochess-log-off";
// The queue shares localStorage with the autosave, so it is capped rather than
// left to grow on a browser that can never send.
const QUEUE_MAX = 200;

export interface GameMeta {
  uid: string;
  /** The position the log replays from — not always the opening. */
  startFen: string;
  /**
   * The `?p=` payload the game was opened from, when it was opened from one. A
   * FEN cannot express evolution rights, progress counters or rook charges, so
   * for a shared game it is not enough to replay the log against; the payload
   * is. Null for a game that started from the opening, where the FEN is the
   * whole state.
   */
  startParam: string | null;
  /** Engaged time: the gaps between plies, each capped. */
  activeMs: number;
  lastPlyAt: number | null;
  lastPlies: number;
  /** Takebacks over the whole game. Rides in the save, so a game finished
   *  across two sessions still reports all of them. */
  takebacks: number;
  /**
   * Whether `game_start` has gone out for this game. Not derivable from the ply
   * count: the AI's own opening move makes the human's first move ply 2, and a
   * takeback to the opening makes ply 1 come round twice.
   */
  started: boolean;
  logged: boolean;
}

export interface FinishedGame {
  meta: GameMeta;
  mode: "human-ai" | "human-human";
  level: string | null;
  aiColor: string;
  fromShared: boolean;
  /**
   * The `publish_date` of the daily puzzle this game is an attempt at, or null.
   * A puzzle arrives on the shared-position path, so without this tag it would
   * be indistinguishable from a real share link, and a failed attempt would
   * read as a player being beaten from someone else's position.
   */
  puzzleDate: string | null;
  /** From the human's side; from White's side in human-human. */
  outcome: "win" | "loss" | "draw" | "timeout";
  moves: string[];
  moveTokens: string[];
}

/** The event names the `events` table accepts. */
export type EventName =
  | "page_load"
  | "first_move"
  | "game_start"
  | "game_end"
  | "game_abandon"
  | "tutorial_progress"
  | "share_open"
  | "share_copy"
  | "puzzle_open"
  | "puzzle_solved"
  | "puzzle_failed";

export type Props = Record<string, string | number | boolean | null>;

interface EventRow {
  /** Client-minted and unique, so a retried send cannot become two rows. */
  event_uid: string;
  /** For deltas only; `created_at` is the clock queries order by. */
  client_ts: string;
  anon_id: string;
  session_id: string;
  app_version: string;
  name: EventName;
  game_uid: string | null;
  props: Props;
}

interface GameRow {
  game_uid: string;
  anon_id: string;
  app_version: string;
  mode: string;
  level: string | null;
  ai_color: string;
  from_shared: boolean;
  puzzle_date: string | null;
  start_fen: string;
  start_param: string | null;
  moves: string;
  moves_tokens: string | null;
  outcome: string;
  plies: number;
  duration_ms: number;
}

/**
 * One queued POST. `qid` identifies the entry, since a game row and an event
 * row about the same game share a `game_uid`.
 */
interface QueueEntry {
  qid: string;
  table: "games" | "events";
  row: GameRow | EventRow;
}

// A gap longer than this is someone away from the board, not thinking.
const PLY_CAP_MS = 5 * 60_000;
const MAX_DURATION_MS = 86_400_000;

export function newGameMeta(startFen: string, startParam: string | null = null): GameMeta {
  return {
    uid: crypto.randomUUID(),
    startFen,
    startParam,
    activeMs: 0,
    lastPlyAt: null,
    lastPlies: 0,
    takebacks: 0,
    started: false,
    logged: false,
  };
}

/**
 * Engaged time as reported, clamped here too so the column's bound is a
 * backstop rather than something the app can trip.
 */
export function reportedDurationMs(meta: GameMeta): number {
  return Math.min(Math.max(Math.round(meta.activeMs), 0), MAX_DURATION_MS);
}

/**
 * Adds the time since the previous ply, then re-anchors. A takeback lowers
 * `plies` and only re-anchors. A null anchor (a fresh load) adds nothing, so
 * the time a game sat closed is not counted as play.
 */
export function accruePlyTime(meta: GameMeta, plies: number, now = Date.now()) {
  if (plies === meta.lastPlies) return;
  if (meta.lastPlyAt !== null && plies > meta.lastPlies) {
    meta.activeMs += Math.min(now - meta.lastPlyAt, PLY_CAP_MS);
  }
  meta.lastPlyAt = now;
  meta.lastPlies = plies;
}

function enabled(): boolean {
  try {
    return !!ENDPOINT && !!ANON_KEY && localStorage.getItem(OFF_KEY) === null;
  } catch {
    return false;
  }
}

function anonId(): string {
  let id = localStorage.getItem(ANON_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ANON_ID_KEY, id);
  }
  return id;
}

/** Fallback for a browser that refuses sessionStorage: stable for the page. */
let memorySessionId = "";
let memorySessionStart = 0;

/** Per tab, so "load to first move" is scoped to one visit. */
function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_ID_KEY, id);
      sessionStorage.setItem(SESSION_START_KEY, String(Date.now()));
    }
    return id;
  } catch {
    if (!memorySessionId) {
      memorySessionId = crypto.randomUUID();
      memorySessionStart = Date.now();
    }
    return memorySessionId;
  }
}

/**
 * Since this session began, not since this page load: the session survives a
 * reload, and so should the measurement. Zero before the session has started,
 * which is only before the first event of the visit.
 */
export function msSinceSessionStart(now = Date.now()): number {
  let started = memorySessionStart;
  try {
    started = Number(sessionStorage.getItem(SESSION_START_KEY)) || memorySessionStart;
  } catch {
    /* memory fallback */
  }
  return started > 0 ? Math.max(0, now - started) : 0;
}

function readQueue(): QueueEntry[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.qid === "string") : [];
  } catch {
    return [];
  }
}

function writeQueue(entries: QueueEntry[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries.slice(-QUEUE_MAX)));
  } catch {
    /* storage full or unavailable */
  }
}

/** Queues one row and tries the queue. The only way anything is sent. */
function enqueue(qid: string, table: QueueEntry["table"], row: GameRow | EventRow) {
  writeQueue([...readQueue(), { qid, table, row }]);
  void flush();
}

/**
 * Resolves true when the row is done with: either it landed, or the server
 * rejected it in a way that retrying cannot fix (a duplicate uid, a failed
 * plausibility check). False keeps it queued and stops the flush, which is what
 * a network error, a 5xx, and the three codes below all want.
 */
async function send({ table, row }: QueueEntry): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/rest/v1/${table}`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    // 401/403 is a bad key, so pausing beats emptying the queue into the bin.
    // 429 is an invitation to try again.
    const retryable = res.status === 401 || res.status === 403 || res.status === 429;
    return res.ok || (res.status >= 400 && res.status < 500 && !retryable);
  } catch {
    return false;
  }
}

let flushing = false;

async function flush() {
  if (!enabled() || flushing) return;
  flushing = true;
  try {
    let pending = readQueue();
    while (pending.length > 0) {
      const entry = pending[0];
      if (!(await send(entry))) return;
      // Re-read rather than splice a stale copy: a game can finish, or an
      // event fire, mid-flush.
      pending = readQueue().filter((e) => e.qid !== entry.qid);
      writeQueue(pending);
    }
  } finally {
    flushing = false;
  }
}

/** Sends whatever earlier visits could not. */
export function initTelemetry() {
  try {
    void flush();
  } catch {
    /* never blocks startup */
  }
}

/** Queues one funnel event. Never throws, never blocks, never awaited. */
export function track(name: EventName, props: Props = {}, gameUid?: string) {
  try {
    if (!enabled()) return;
    const qid = crypto.randomUUID();
    const row: EventRow = {
      event_uid: qid,
      client_ts: new Date().toISOString(),
      anon_id: anonId(),
      session_id: sessionId(),
      app_version: __APP_VERSION__,
      name,
      game_uid: gameUid ?? null,
      props,
    };
    enqueue(qid, "events", row);
  } catch {
    /* never reaches the player */
  }
}

// Module-level, not effect state: StrictMode mounts every effect twice in
// development, and an effect-local guard would let that become two rows.
const fired = new Set<string>();

/** `track`, but at most once per page load for a given key. */
export function trackOnce(key: string, name: EventName, props: Props = {}, gameUid?: string) {
  if (fired.has(key)) return;
  fired.add(key);
  track(name, props, gameUid);
}

/** `track`, but at most once per session: a reload does not re-fire it. */
export function trackSessionOnce(key: string, name: EventName, props: Props = {}, gameUid?: string) {
  if (fired.has(key)) return;
  fired.add(key);
  try {
    if (sessionStorage.getItem(SESSION_FIRED_PREFIX + key)) return;
    sessionStorage.setItem(SESSION_FIRED_PREFIX + key, "1");
  } catch {
    /* the page-load guard above is all there is */
  }
  track(name, props, gameUid);
}

/** Queues one finished game and tries to send it. Call once per game. */
export function logFinishedGame(game: FinishedGame) {
  try {
    if (!enabled()) return;
    const qid = crypto.randomUUID();
    const row: GameRow = {
      game_uid: game.meta.uid,
      anon_id: anonId(),
      app_version: __APP_VERSION__,
      mode: game.mode,
      level: game.mode === "human-ai" ? game.level : null,
      ai_color: game.aiColor,
      from_shared: game.fromShared,
      puzzle_date: game.puzzleDate,
      start_fen: game.meta.startFen,
      start_param: game.meta.startParam ?? null,
      moves: game.moves.join(" "),
      moves_tokens: game.moveTokens.join(" "),
      outcome: game.outcome,
      plies: game.moves.length,
      duration_ms: reportedDurationMs(game.meta),
    };
    enqueue(qid, "games", row);
  } catch {
    /* never reaches the player */
  }
}
