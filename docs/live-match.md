# Live match MVP

The smallest thing two people can play over a link.

## Shape

- Moves only over the wire. Both clients run the engine. The backend knows no
  chess.
- Polling with bare `fetch`, like `telemetry.ts`. No new dependency.
- The match id in the link is the read capability. A per-seat token in
  `localStorage` is the write capability. It never appears in a URL.
- Untimed. No clocks.
- `live` is not a mode. It is vs-Human with a transport, so `mode` stays
  two-valued and persistence and scoring types are untouched.

Later: takeback, presence, seat reclaim, `beforeunload` guard, e2e tests,
websockets.

Rules the build settled:

- Creating a match puts it on the board, replayed from `start_payload` with an
  empty move list, so the creator's first send is ply 1 just like the joiner's.
- Takeback and "play from here" are hidden while a match is on the board, and
  the functions refuse too: both rewind the move list, and the server will not
  take a ply it already holds. Browsing stays, being read-only.
- New Game and "back to my game" are the only ways out, both through
  `leaveLiveMatch`, which drops the seat, the `?lm=` parameter and the poll
  together. Both ask first, New Game even at ply 0. Otherwise a stale poll keeps
  applying the opponent's moves onto the game just restored.

## Relevant files

- sql/live-match.sql
- src/liveMatch.ts
- src/features/live/useLiveMatch.ts
- src/components/ConfirmModal.tsx
- src/components/InviteModal.tsx
- src/App.tsx

## Backend

One function set, `security definer`. The anon key gets EXECUTE and nothing
else: no SELECT, INSERT, UPDATE or DELETE on any table.

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

`opts` is `ApplyMoveOptions` as JSON. The primary key dedupes a retried send,
fixes the order, and makes a double insert at one ply impossible. Every
attacker-controlled column is bounded by a `check`, the cheapest place for a
bound and one a client cannot forget. On receipt the client rebuilds `opts` by
allowlisting keys, never by spreading it.

Turn ownership is ply parity against `first_mover`: odd plies are
`first_mover`'s, even plies the other side's. That is the whole "White cannot
append Black's moves" rule, and it lives in `lm_play`. Parity alone would still
let a seat holder insert far-future plies, so `lm_play` also pins the ply to
`coalesce(max(ply), 0) + 1`. Moves are append-only as well as alternating.

Tokens come from `gen_random_bytes(32)` (pgcrypto), base64url'd. Not `random()`,
which is seeded and predictable. The token is all that stands between a reader
and a seat.

| Function | Does |
|---|---|
| `lm_create(start_payload, first_mover, creator_seat)` → `(match_id, token)` | Generates the id and the creator's token. |
| `lm_join(match_id)` → `(seat, token)` | Conditional update on the null token column; sets `status='live'`. Zero rows means the seat is taken → raise. That one statement is the entire race resolution. |
| `lm_play(match_id, token, ply, from, to, opts)` | Rejects unless `status='live'`, the token matches the seat owning `ply` by parity, and `ply` is exactly one past the highest stored ply. PK conflict surfaced distinctly. |
| `lm_fetch(match_id, since_ply)` | Returns status, `first_mover`, `start_payload`, `free_seat` (so the join button can name the colour), and every move above `since_ply` in order. Never returns a token. Unknown id returns nothing. |

`lm_fetch` is the only read path in the app. `created_at` on a move is how stale
a match is; retention and abandonment both need it, and `lm_fetch` never returns
it. Rows are deletable after 30 days. No player identifier is stored.

**Observers are free.** Anyone with the link can call `lm_fetch` and watch, and
cannot move: `lm_play` needs a seat token, and only `lm_create` and `lm_join`
return one. Which is why **`lm_join` is never called on page load**. Joining
takes a deliberate act, or the first person to open a link pasted into a group
chat becomes the opponent, and there is no seat reclaim to undo it.

## Milestone 1: playable, no UI

`src/liveMatch.ts`, the two touch points in `App.tsx` a move passes through, and
the join button. Nothing in `ControlsPanel` or the share dialog.

Creating a match is a console call, exposed on `window` in this build:

```js
await evoLive.create("w")   // → the invite URL, already copied to the clipboard
```

It calls `lm_create` with the current position's `?p=` payload (null at the
opening), stores the seat under `evochess-live-v1`, and switches to vs-Human
mode.

Opening `?lm=<id>` fetches the match and shows it read-only. Taking the seat is a
second step: one button, "Play as Black", calling `lm_join`. If the seat is
taken, or the match is unknown or over, the button is not offered. That button is
the only control M1 adds. On success the seat is stored and play begins. This
reuses the existing `?p=` inbound path, so the opener's own autosave is parked as
it already is for a shared link. The result is not scored locally.

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
  vs-AI turn guard. No seat token means every move is refused. That is the
  observer case.
- `applyAndAdvance` calls `sendMove` after the move applies locally, so the board
  never waits on the network. A failed send retries with backoff. A PK conflict
  counts as success.
- Poll `lm_fetch` at 1200 ms while it is the opponent's turn or while waiting for
  a join, never on the local turn. Stop on `document.hidden`, poll once on
  becoming visible, stop at game end.
- A move at the expected ply goes through `applyAndAdvance`, so the move log,
  history and game-end detection are unchanged code.
- A gap, or a remote move the engine rejects, refetches from ply 0 and replays
  from the start position. Replay is also how a reload resumes.

The status line gains one string: when it is not the local turn, either waiting
for the opponent to join, or for their move.

Tests, mocked `fetch`, in the style of `telemetry.test.ts`: parity → seat for
both values of `first_mover`; replay equals playing move by move; a gap triggers
refetch and replay; the poll stops on the local turn, on hidden, and at game end;
`?lm=` issues no `lm_join` until the button is pressed; an unknown key in `opts`
is dropped. Two-browser play is checked by hand.

## Milestone 2: New Game chooses the mode

M1 works and cannot be found. M2 makes it reachable.

### The mode picker moves into New Game

Changing mode already restarts the game (`onRestart("mode", …)`), so the picker
is a new game in disguise. M2 drops it for three New Game options:

| Option | Mode | Then |
|---|---|---|
| Computer | `human-ai` | As today. Colour and level. |
| Friend | `human-human` | Creates a match, shows the invite link. |
| Over the board | `human-human` | As today, both sides local. |

Consequences:

- `RestartReason` loses `"mode"`. `"color"` and `"level"` stay in
  `ControlsPanel`, still disabled after the first move.
- New Game stays one dialog. The three options and the "discards N moves"
  warning share it. Choosing is the confirmation.
- The Friend row carries its own seat choice, two kings on the same line as the
  button, one selected. Its value is passed to `createLiveMatch(seatColor)`. Not
  the panel's colour picker, which only exists in vs-AI and so is not on screen
  when New Game is pressed from a human-vs-human game.
- One-word labels, and a 280px dialog rather than one as wide as its longest
  sentence.

New Game resets the board first, so a match created here starts at the opening
and `start_payload` is null. Starting one from the current position stays on the
console.

### The invite

`createLiveMatch` already returns the URL and copies it. M2 gives it a dialog:
link, copy button, waiting state. It closes to the board; the waiting status line
brings it back.

### States with no UI yet

M1 handles all of these and says so only to the console.

| State | Shown as | Needs |
|---|---|---|
| Waiting for your friend | Status line, plus the invite dialog | Nothing. `status === "waiting"`. |
| Opponent's turn | Status line, styled like the AI's "thinking" | Nothing. |
| Read-only | Banner, no drag affordance | Nothing. `seat === null` already refuses moves. |
| Cannot join | `TopBanners` notice, with a way to start a normal game | Nothing. `setLinkNotice` carries it. |
| Connection lost | Status line after three failed polls. Keeps retrying, keeps the board | `lmFetch` returns null for a failure and an unknown match alike. Split them, then count. |
| Out of sync | Status line, terminal, offers a new game only | A flag set where `replay` fails and where a send is refused. |

So: two additions to the transport, and the rest is presentation.

- `lmFetch` returns `LiveState | "unknown" | null`: an answer, no such match, or
  a failed read. Only the last is counted, by `countFailure`/`isConnectionLost`,
  and any answer resets the count. Three, about four seconds at 1200 ms.
- An answer merges onto the view as it is now, not the one polled against: the
  seat and `outOfSync` are ours, and a slow read must not undo them. Retrying
  includes our own turn while lost, since only a read that works clears it.
- `LiveView` gains `outOfSync`. `shouldPoll` and `canMoveNow` return false on
  it, which is what makes it terminal. Only New Game clears it, by dropping the
  match. It is set where `replay` fails and where a send is refused; a refused
  send no longer resyncs, since no refetch can unplay a move already on our
  board.

Rules the build settled:

- New Game always opens the dialog, even at ply 0 with nothing to discard: the
  dialog is where the mode is picked, so there is nothing to skip to. The colour
  and level switches keep the old two-button confirm.
- The waiting status line is a button that reopens the invite. Closing the
  dialog would otherwise lose the only copy of the URL.

`LiveProps` carries these to `BoardArea`. Nothing else in the prop tree changes.

Mobile first. Watch the invite dialog: a URL is long, and must wrap rather than
widen the page.

### Tests

- Each New Game option lands in the right mode. Live creates a match.
- A failed poll is not an unknown match. Three raise connection-lost; a success
  between them resets.
- The out-of-sync flag stops the poll and refuses a local move.

Two-browser play still checked by hand.

## Milestone 2b: game over, then rematch

Game over ends the warnings. No "leaving the game", no "giving up the seat":
the seat is worth nothing once the result is in.

Then both players see one green **Rematch** button.

| Seen | You | Opponent |
|---|---|---|
| Neither asked | Green "Rematch" | Green "Rematch" |
| You asked | Waiting | Line above the button: "Your opponent wants a rematch". Button turns blue, reads "Accept" |
| Both asked | New match starts | New match starts |

On rematch the seats swap colour. Whoever was White plays Black.

Transport: the ask is a flag per seat on the match row, polled like the moves.
Both flags set creates the new match, its id written back so each side follows
it. The poll keeps running after game end while a rematch is pending.

Rules the build settled:

- `lm_rematch` is the ask, the accept, and how each side collects its token for
  the next match, which `lm_fetch` will not give it. The row is locked, so two
  accepts at once create one match.
- The poll runs after game over for any seat holder, not only once an ask is in:
  an ask you cannot see is an ask nobody can answer. It stops at `rematch_id`.
- The old match is set `over`, and `?lm=` and the stored seat move to the new
  one, so a reload lands in the rematch.
- The offer survives browsing: it is the only sign the opponent asked.
- Untimed is enforced: a match switches the clock off, since only one side
  would see a flag fall. Auto flip goes with it, the seat orienting the board.

## Milestone 2c: draw and resign

M2b ends a match when the rules do. M2c lets the players end one.

### Menu

While a match is live, the New Game button reads **Menu**: **Draw** and
**Resign**. Resigning is the only way out. A match still waiting for its
opponent reads New Game, which is how it is abandoned before anyone arrives.

Once the game is over, Menu reads **New Game** again, and **Rematch** appears as
it does after a checkmate.

### Draw

The offer stands until answered.

| Seen | You | Opponent |
|---|---|---|
| No offer | "Draw" | "Draw" |
| You offered | Waiting | "Your opponent offers a draw", with Accept and Decline |
| Accepted | Drawn | Drawn |
| Declined | "Draw" again | "Draw" |

An unanswered offer dies on the opponent's next move, so a stale offer cannot be
accepted against a changed position. Decline clears it too. Either side may
offer again.

Pressing Draw against a standing offer accepts it. Crossing offers agree.

### Resign

Unilateral, and immediate. It asks first, through `ConfirmModal`: one misclick
should not lose a game.

### Backend

M3's `lm_end` and `outcome`, pulled forward, plus one column for the offer.

```sql
alter table lm_matches
  add column outcome    text,    -- null | 'w' | 'b' | 'd'
  add column draw_offer char(1); -- null | 'w' | 'b': whose offer stands
```

`lm_end(match_id, token, action)`, where `action` is `resign`, `draw_offer`,
`draw_accept` or `draw_decline`. Verifies the token owns a seat and
`status='live'`.

- `resign` sets `outcome` to the other seat, `status='over'`.
- `draw_offer` records the caller's seat. Against a standing offer from the
  other seat it accepts instead. That is the crossing case.
- `draw_accept` requires the other seat's offer, then `outcome='d'`,
  `status='over'`. One statement on a locked row, so two accepts cannot both win.
- `draw_decline` clears the offer, and only the other seat's.

`lm_play` clears `draw_offer` when the ply belongs to the seat it was made
against. That is how an offer dies, in one assignment on a statement that
already runs.

`lm_fetch` returns `outcome` and `draw_offer`, so endings arrive on the poll
that carries moves. No new read path.

`outcome` carries only chosen endings. Checkmate and stalemate stay local, from
the move list. The server is not told what it cannot check.

### Client

- `LiveView` gains the standing offer and the outcome. `canMoveNow` is false once
  an outcome is in.
- **The poll now runs on our own turn too.** It used to stop there, since no
  move can arrive on it. A resignation can, and a board still saying "your move"
  after the opponent resigned is the one thing this must not do. Reading
  throughout also subsumes the connection-lost exception M2 needed.
- A resignation or agreed draw takes the same game-over path as a checkmate, so
  the overlay, fireworks and move log are unchanged code. Still not scored
  locally.

Mobile first. Accept and Decline are two full-width buttons, not two words on a
line.

### Tests

- An offer dies on the opponent's move and cannot then be accepted.
- Crossing offers draw.
- Decline clears the offer, the game stays live.
- Resign sets the other seat, both clients end.
- Menu shows Draw and Resign while live, New Game and Rematch once over.
- The poll runs on our own turn, and stops on an outcome unless a rematch is
  still to be had.

## Accepted limits

- A tampered client can post a move its board never made. The opponent's client
  rejects it and both sides see the match break. Nobody is cheated silently, and
  server-side rules would mean a second EvoChess implementation.
- Losing `localStorage` loses the seat. The player can still watch. Reclaiming a
  seat safely needs presence, which is not in this MVP.
- The link is public once sent. Sending it to the wrong person is the one mistake
  the design cannot catch. What it does avoid is losing the seat to someone who
  only meant to look.
- The anon key ships in the bundle and always has. With no table grants it buys
  nothing but `lm_create` spam. That is rate limiting's job, and is already true
  of today's telemetry inserts.
