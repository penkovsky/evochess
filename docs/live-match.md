# Live match MVP

The smallest thing two people can play over a link.

Status: M1 built (`sql/live-match.sql`, `src/liveMatch.ts`, `src/App.tsx`,
`src/__tests__/liveMatch.test.ts`); M2 is still design. The schema has to be
applied by hand, like every other file in `sql/`. `lm_fetch` also returns
`free_seat`, so the join button can name the colour it is offering.

Three rules the build settled that the sections below do not spell out. Creating a
match puts that match on the board, replayed from `start_payload` with an empty
move list, so the creator's first send is ply 1 exactly as the joiner's is.
Takeback and "play from here" are hidden while a match is on the board, and the
functions refuse as well as the buttons: both rewind the move list, and the
server will not take a ply it already holds. Browsing stays, being read-only.

Leaving is the third. New Game and "back to my game" are the two ways out, and
both go through `leaveLiveMatch`, which drops the seat, the `?lm=` parameter and
the poll together. Neither may leave by accident, so both ask first. "Back to my
game" gets its own dialog, since what it costs is the seat and not the moves,
and New Game asks even at ply 0 for the same reason. Without this, a stale poll
keeps applying the opponent's moves onto the game just restored.

## Shape

- Moves only over the wire. Both clients run the engine. The backend knows no
  chess.
- Polling, bare `fetch` like `telemetry.ts`. No new dependency.
- The match id in the link is the read capability. A per-seat token in
  `localStorage` is the write capability. It never appears in a URL.
- Untimed. No clocks, no clock columns.

Dropped until asked for: takeback, resign, draw, presence, rematch, seat
reclaim, `beforeunload` guard, `lm_end`, the `outcome` column, e2e tests,
websockets.

## Backend

One function set, `security definer`. The anon key gets EXECUTE and nothing
else. No SELECT, INSERT, UPDATE or DELETE on any table. Today's insert-only,
read-nothing posture is unchanged.

```sql
create table lm_matches (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  start_payload text check (length(start_payload) <= 2048), -- ?p=, null at the opening
  first_mover   char(1) not null,              -- 'w' | 'b'
  white_token   text not null,
  black_token   text,                          -- null until the seat is claimed
  creator_seat  char(1) not null,
  status        text not null default 'waiting' -- waiting | live | over
);

create table lm_moves (
  match_id uuid not null references lm_matches(id) on delete cascade,
  ply      int  not null check (ply between 1 and 1000),
  from_sq  text not null check (from_sq ~ '^[a-h][1-8]$'),
  to_sq    text not null check (to_sq   ~ '^[a-h][1-8]$'),
  opts     jsonb not null default '{}'::jsonb
                 check (pg_column_size(opts) <= 256),
  created_at timestamptz not null default now(),
  primary key (match_id, ply)
);
```

`opts` is `ApplyMoveOptions` as JSON. The primary key is load-bearing. It
dedupes a retried send, fixes the order, and makes a double insert at one ply
impossible.

Every attacker-controlled column is bounded by a `check`. That is the cheapest
place for a bound, and a client cannot forget it. `opts` is a few short fields,
so 256 bytes is generous. `start_payload` is a `?p=` payload, so 2 KB is. On
receipt the client rebuilds `opts` by allowlisting keys, never by spreading it.
An unexpected key is dropped before the engine sees it.

Turn ownership is ply parity against `first_mover`. Odd plies are
`first_mover`'s, even plies the other side's. **This is the whole "White cannot
append Black's moves" rule.** It lives in `lm_play`, not the client.

Parity alone still lets a seat holder insert any ply of their own colour,
including far-future ones. That means unbounded rows and a permanent gap in the
opponent's move list. So `lm_play` also pins the ply to
`coalesce(max(ply), 0) + 1`. One sub-select in the same statement. Moves are now
append-only as well as alternating.

Tokens come from `gen_random_bytes(32)` (pgcrypto), base64url'd. Not `random()`,
which is seeded and predictable. Not a uuid either. The token is all that stands
between a reader and a seat, so it is the one value that has to be
cryptographic.

Four functions:

| Function | Does |
|---|---|
| `lm_create(start_payload, first_mover, creator_seat)` → `(match_id, token)` | Generates the id and the creator's token. |
| `lm_join(match_id)` → `(seat, token)` | Conditional update on the null token column; sets `status='live'`. Zero rows means the seat is taken → raise. That one statement is the entire race resolution. |
| `lm_play(match_id, token, ply, from, to, opts)` | Rejects unless `status='live'`, the token matches the seat owning `ply` by parity, **and `ply` is exactly one past the highest stored ply**. Inserts. PK conflict surfaced distinctly. |
| `lm_fetch(match_id, since_ply)` | Returns status, `first_mover`, `start_payload`, whether the second seat is taken, and every move above `since_ply` in order. Never returns a token. Unknown id returns nothing. |

`created_at` on a move is how stale a match is: `max(created_at)` is its last
move, and nothing else advances after creation. Retention and abandonment both
need that. `lm_fetch` never returns it.

`lm_fetch` is the only read path in the app. Rows are deletable after 30 days.
No player identifier is stored.

**Observers are free.** Anyone with the link can call `lm_fetch` and watch. They
cannot move. `lm_play` needs a seat token, and only `lm_create` and `lm_join`
return one. This holds in M1, which has no observer UI.

Which is why **`lm_join` is never called on page load**. The link only reads.
Joining turns it into a write capability, so it takes a deliberate act.
Otherwise the first person to open a link pasted into a group chat becomes the
opponent. The invited player arrives second and watches their own game, with no
seat reclaim in this MVP to undo it.

## Milestone 1: playable, no UI

`src/liveMatch.ts`, the two touch points in `App.tsx` a move passes through, and
the join button below. Nothing in `ControlsPanel` or the share dialog.

Creating a match is a console call, exposed on `window` in this build:

```js
await evoLive.create("w")   // → the invite URL, already copied to the clipboard
```

It calls `lm_create` with the current position's `?p=` payload (null at the
opening), stores the seat under `evochess-live-v1`, and switches to vs-Human
mode.

Opening `?lm=<id>` fetches the match and shows it read-only. Taking the seat is
a second step: one button, "Play as Black", which calls `lm_join`. If the seat
is taken, or the match is unknown or over, the button is not offered and the
client stays read-only. That button is the only control M1 adds. Everything else
stays on the console.

On success the seat is stored and play begins. This reuses the existing `?p=`
inbound path, so the opener's own autosave is parked as it already is for a
shared link. The result is not scored locally.

Seat record:

```ts
interface LiveSeat {
  matchId: string;
  seat: "w" | "b";
  token: string;
  firstMover: "w" | "b";
  startPayload: string | null;
}
```

Behaviour:

- `attemptMove` refuses unless the ply belongs to the local seat, mirroring the
  vs-AI turn guard. **No seat token → every move is refused.** That is the
  observer case, and the whole point.
- `applyAndAdvance` calls `sendMove` after the move applies locally, so the
  board never waits on the network. A failed send retries with backoff. A PK
  conflict counts as success.
- Poll `lm_fetch` at 1200 ms while it is the opponent's turn, or while waiting
  for a join. Never on the local turn. Nothing can arrive then. Stop on
  `document.hidden`, poll once on becoming visible, stop at game end.
- A move at the expected ply goes through `applyAndAdvance`. The move log,
  history and game-end detection are unchanged code.
- A gap, or a remote move the engine rejects, refetches from ply 0 and replays
  from the start position. Replay is also how a reload resumes.

The status line gains one string: when it is not the local turn, either waiting
for the opponent to join, or for their move.

Tests, mocked `fetch`, in the style of `telemetry.test.ts`: parity → seat for
both values of `first_mover`; replay equals playing move by move; a gap triggers
refetch and replay; the poll stops on the local turn, on hidden, and at game
end; `?lm=` issues no `lm_join` until the button is pressed; an unknown key in
`opts` is dropped. Two-browser play is checked by hand.

## Milestone 2: New Game picker

New Game offers three options:

| Option | Mode | Then |
|---|---|---|
| vs AI | `human-ai` | As today. |
| vs Friend | `human-human` | Creates a live match and shows the invite link. |
| Over the board | `human-human` | As today, both sides local. |

So `live` is not a fourth mode. It is vs-Human with a transport attached. `mode`
stays two-valued, and the persistence and scoring types are untouched.

vs Friend replaces M1's console call. Create, show the link with a copy button,
then wait for the second seat. If the creator holds the side to move, they may
move before anyone joins. It is stored and waiting when the opponent arrives.

Also in M2, since they are one screen's worth of text between them:

- Cannot-join notice in `TopBanners`. Covers full, unknown or over. Includes a
  way to start a normal game.
- Read-only banner for an observer, and no drag affordance on the board.
- Connection-lost line after three failed polls. Keeps retrying, keeps the
  board.
- Out-of-sync line for divergence. Terminal for that match. Offers a new game
  and nothing else.

Mobile first, as everywhere else. Each of these has to read on a narrow screen
without pushing the board or the evo strip out of view.

## Accepted limits

- A tampered client can post a move its board never made. The opponent's client
  rejects it and both sides see the match break. Nobody is cheated silently, and
  server-side rules would mean a second EvoChess implementation.
- Losing `localStorage` loses the seat. The player can still watch. Reclaiming a
  seat safely needs presence, which is not in this MVP.
- The link is public once sent. Holding it means reading the game, and taking
  the free seat by pressing the button. Sending it to the wrong person is the
  one mistake the design cannot catch. What it does avoid is losing the seat to
  someone who only meant to look.
- The anon key ships in the bundle and always has. With no table grants it buys
  nothing but `lm_create` spam. That is rate limiting's job, and is already true
  of today's telemetry inserts.
