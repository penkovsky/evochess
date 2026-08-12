# Share links: URL-encoded positions and games

Status: partly built. Position links and history links both work end to end:
the codec is `src/evochess/shareLink.ts`, the inbound `?p=` load and the
outbound Share button are in `App.tsx` and `useShareModal`. The extras block
(§4.5) is still design only.

This document is normative for the wire format. What ships today is a strict
subset of it: the encoder writes flags `0x00` for a position and `0x01` for a
position plus a move line, so no payload carries extras. The decoder skips an
extras block it does not need, so a link written by a later encoder still
opens. That behaviour is §4.2's, and it needs no version bump to grow into the
full format.

## 1. Goal

Let a player put an Evochess position, or a whole game, into a URL. The link
can be pasted into Discord, Reddit, or a chat app. People can then argue about
a position by pointing at it.

No backend is needed. The payload is decoded client-side, exactly like
`persistence.ts` decodes `localStorage`.

It is a prerequisite for the daily-puzzle idea in the same file, since a puzzle
link is just a position link with a fixed seed.

## 2. Decisions

| Question | Decision |
|---|---|
| Scope | One format. A link always carries a position. A move history is optional. |
| Encoding | Bit-packed binary, then base64url, no padding. |
| URL location | Query parameter `?p=…` on the existing path. |
| Existing autosave | The shared link loads immediately. The recipient's autosave stays intact and restorable. |
| History entry point | The link carries a ply cursor, so the sharer can point at any ply. |
| History base | The start position is encoded explicitly. It is not assumed to be the standard opening. |
| Versioning | Leading version byte. Unknown versions are refused with a clear message. |
| Validation | CRC-16 checksum and a full legality check. A legality failure still renders the board, but disables engine search for that game. |
| Extras carried | Board orientation (`autoFlip` and view side), mode, AI level. No caption. |
| UI | Deferred to a later milestone (§9). |

### Why query, not fragment

Query beats `#p=…` because some chat clients, email rewriters, and shorteners
truncate at `#`. That would break a share silently. The cost is that the
payload reaches GitHub's request logs and `Referer` headers. For a chess
position that is acceptable.

## 3. URL grammar

```
https://evochess.example/evochess/?p=<base64url>
```

- `base64url` uses the RFC 4648 §5 alphabet (`A-Z a-z 0-9 - _`) with padding
  stripped. None of those characters need percent-encoding, so the link
  survives being pasted raw.
- The parameter is read once on app start. It is dropped from the address bar
  with `history.replaceState`, but not until the shared game becomes live,
  meaning the recipient's first move. Stripping it on load is worse: the shared
  game is held in memory only until that point (§6), so a reload or a mobile
  tab restore would silently discard it and show the recipient's own autosave
  instead. Keeping it until the first move also stops a later reload from
  re-loading the base position over moves the recipient had played.
- Unknown query parameters are ignored.

## 4. Payload layout

The payload is a byte string:

```
+---------+---------+------------------------+----------+
| version | flags   | bitstream (§4.3)       | CRC-16   |
| 1 byte  | 1 byte  | variable, byte-padded  | 2 bytes  |
+---------+---------+------------------------+----------+
```

The bitstream is written MSB-first within each byte. It is zero-padded to a
byte boundary. The CRC covers every preceding byte, version and flags
included.

### 4.1 Version byte

`0x01` for the format described here.

A decoder that sees any other value stops immediately. It reports "This link
was created with a different version of Evochess." It does not try to
interpret the rest.

This matters because the rules themselves have been revised. Rook charges were
added, and rook rights moved from captures to minor-piece moves. See the
revision notes at the end of `rules.txt`. The same bits can mean a materially
different position after a rules change. Silently loading it would be worse
than refusing.

Bump the version byte whenever the encoding changes, and also whenever the rule
semantics of the encoded fields change.

### 4.2 Flags byte

| Bit | Meaning |
|---|---|
| 0 | history present (§4.4) |
| 1 | extras present (§4.5) |
| 2-7 | reserved. Must be written 0, and must be rejected if non-zero. |

Reserved bits are rejected when set so that a v1 decoder refuses a link using a
bit it does not understand, rather than loading a position with part of its
meaning missing. That is the whole reason. It is not a forward-compatibility
mechanism: because setting one of these bits makes every existing decoder
refuse, spending one later needs a version bump anyway, which is what §10
assumes. Reserving them is still worth doing, since it is what makes that later
bump a clean choice instead of a compatibility break.

### 4.3 Position block

This encodes everything `SerializedGame` holds except `moveLog`. The move log
is regenerated by replay when history is present, and is empty otherwise.

Fields are written in this order.

**1. Occupancy, 64 bits.** One bit per square. The index is `a1 = 0 … h8 = 63`,
that is `(rank - 1) * 8 + file`. This matches `nameToSq` in
`evoBitboard.ts:64`.

**2. Piece nibbles, 4 bits per occupied square,** in ascending square index.

| Value | Piece | | Value | Piece |
|---|---|---|---|---|
| 0 | white pawn | | 6 | black pawn |
| 1 | white knight | | 7 | black knight |
| 2 | white bishop | | 8 | black bishop |
| 3 | white rook | | 9 | black rook |
| 4 | white queen | | 10 | black queen |
| 5 | white king | | 11 | black king |

Values 12 to 15 are invalid and are a decode error. Queens arise only from
8th-rank promotion, but they do arise, so they get a code.

Typical cost is 8 bytes of occupancy plus one nibble per piece. That is 17
bytes for the 18-piece starting position, and about 14 to 20 bytes mid-game.

**3. Rook charges, 3 bits per rook on the board,** in ascending square index,
with value 1 to 5. Values 0, 6, and 7 are decode errors.

This replaces the sparse `rookCharges` map. The rook set is already known from
step 2. `game.ts:107-109` treats a rook with no map entry as fully charged, so
per-rook encoding is lossless. Any map entry not standing under a rook is stale
and is dropped by the encoder.

**4. Rook-locked bits, 1 bit per knight or bishop on the board,** in ascending
square index. A set bit means the piece was downgraded from a rook and can
never be promoted back. See `rules.txt` §5. The reasoning matches charges:
`rookLocked` only ever holds squares occupied by minor pieces.

**5. Side to move, 1 bit.** `0` is white, `1` is black.

**6. Evolution counters.**

| Field | Bits | Range |
|---|---|---|
| `pawnMoveProgress.w` | 2 | 0-2 |
| `pawnMoveProgress.b` | 2 | 0-2 |
| `minorMoveProgress.w` | 2 | 0-2 |
| `minorMoveProgress.b` | 2 | 0-2 |
| `minorRights.w` | 4 plus escape | 0-14, `15` escapes |
| `minorRights.b` | 4 plus escape | same |
| `rookRights.w` | 4 plus escape | same |
| `rookRights.b` | 4 plus escape | same |

The progress counters are always below `N_MINOR` and `M_ROOK`, both 3, by
construction. A value of `3` is a decode error.

Rights accumulate indefinitely per `rules.txt` §4. So `15` escapes to a
following 8-bit value holding the true count. A real game cannot reach 256
unspent rights, so 8 bits is enough.

That escaped value must itself be 15 or more. A smaller one fits in the 4-bit
field, so accepting it would give the same count two valid encodings, and the
canonicality this format claims in §5.1 would hold in one place and not another.
Below 15 in the escape is a decode error.

**7. En passant, a 2-bit tag.** A normal and an evolved en passant can never
coexist, because each is created by the same single double-pawn move.

| Tag | Meaning | Payload |
|---|---|---|
| 0 | none | none |
| 1 | standard en passant | 3 bits, file of the skipped square |
| 2 | evolved en passant (`epEvolved`) | 3 bits, file of the skipped square |
| 3 | invalid | decode error |

Everything else is derivable, so it is not encoded:

- The skipped square's rank is 6 when white is to move, and 3 when black is.
- `epEvolved.victim` is the same file, one rank further from the mover. That is
  rank 5 and rank 4 respectively.
- `epEvolved.color` is the side not to move. The right lasts exactly one ply.
  See `game.ts:287-289`.
- `epEvolved.index` is chess.js's 0x88 index of the skipped square. It is
  computed on decode rather than trusted from the URL.

**8. Halfmove clock, 7 bits,** 0 to 100. Above 100 is a decode error. This is
needed for the fifty-move rule.

**9. Fullmove number, 8 bits,** where `255` escapes to a following 16-bit
value. As with the rights escape, that value must itself be 255 or more;
anything smaller is a decode error, for the same canonicality reason.

The FEN handed to `chess.load()` is reassembled from steps 1, 2, and 5 to 9.
The castling field is always `-`, since castling is undefined in Evochess.

Step 7 is the one exception to that reassembly. Tag 1 writes the skipped square
into the FEN's en passant field. Tag 2 must write `-` there and carry the
opportunity in `epEvolved` instead. A FEN that names the skipped square while a
minor piece stands on the victim square is exactly the corruption
`EvolvedEnPassant` exists to prevent (`game.ts:61-73`): chess.js's en-passant
undo hardcodes restoring a pawn on the victim square, so every legality trial
inside `fen()` or `moves()` makes and unmakes the capture and stamps a pawn over
the minor piece.

Nothing catches this for us. `load()` assigns `_epSquare` straight from the FEN
token and never calls `_updateEnPassantSquare`, which only runs from `put()` and
`remove()`. So a decoder that reassembles the field mechanically from step 7
corrupts the board on the very first `fen()` call, on both the validated and the
`skipValidation` path. The evolved-en-passant test in §8 is the guard: assert
`epEvolved` is populated *and* that the reassembled FEN's en passant field is
`-`.

Repetition history is not carried, and cannot be. chess.js detects threefold
repetition from its own move history, which a loaded FEN does not have. So a
position-only link starts that count from zero, and a position that stood one
repetition short of a draw will not be scored as one. The halfmove clock above
means the fifty-move rule is unaffected, and a history link is unaffected too,
because replay rebuilds the history. This is a known limit of position-only
links, not a bug.

### 4.4 History block

This block is present only when flags bit 0 is set. The position block above is
then the base position. The position actually shown is produced by replaying
the moves onto it.

```
ply count      : 12 bits (0-4095)
moves          : ply count moves, 15 or 17 bits each (see below)
ply cursor     : 12 bits
```

Each move is `from` (6 bits), `to` (6 bits), and a 3-bit tag:

| Tag | Meaning | Extra bits |
|---|---|---|
| 0 | plain move | none |
| 1 | evolve the pawn that moved to a knight (`minorPromo: "n"`) | none |
| 2 | evolve the pawn that moved to a bishop (`minorPromo: "b"`) | none |
| 3 | evolve the minor that moved to a rook (`rookPromo: true`) | none |
| 4 | rook spent its last charge, becomes a knight (`downgradeTo: "n"`) | none |
| 5 | rook spent its last charge, becomes a bishop (`downgradeTo: "b"`) | none |
| 6 | 8th-rank promotion (`forcedPromo`) | 2 bits: 0=q, 1=r, 2=b, 3=n |
| 7 | reserved, decode error | none |

The tags are mutually exclusive. That mirrors `ApplyMoveOptions`. Only one
piece may be promoted per move. A forced promotion precludes any other
promotion, per `game.ts:219-221`. A downgrade is valid only on a rook move, per
`game.ts:229-231`.

The evolved en passant needs no tag. `applyMove` recognises it from the
position through `matchEvolvedEnPassant`.

Tag 6 is the only tag that carries extra bits, so a move is 15 bits, or 17 bits
for an 8th-rank promotion. The move array is variable-length, not a fixed
stride. It stays self-delimiting because each tag is read before its own
payload, so a decoder never needs to know a move's length in advance. An
encoder that assumes a flat 15 bits per ply will produce a bitstream that
decodes correctly right up to the first promotion and then silently
desynchronises.

Cost is therefore 15 bits per ply in the common case. An 80-ply game with no
8th-rank promotions is 150 bytes of history on top of a 23-byte base. That is
about 240 base64 characters in total.

#### Ply cursor semantics

The ply cursor is the ply index to display, from `0` to `plyCount`. A value of
`plyCount` means the final position.

Two kinds of link fall out of this, and both are legal in v1:

- **Resume-play link.** History is truncated at the share point, so the cursor
  equals `plyCount`. The recipient arrives at the position and plays on. The
  moves after the share point are simply not in the payload.
- **Scroll-through link.** History runs to the end of the game and the cursor
  points at an earlier ply. The recipient can scroll forward to see what
  actually happened.

The app writes both kinds. The rule is the browsing cursor: `browsePly` when
the sharer is browsing, `plyCount` when they are not. Sharing while browsing
therefore sends the whole line with the cursor pointing back into it, not a
line cut at the cursor, so the recipient can scroll forward. The decoder
honours any cursor value in range, whoever wrote it. §8.1 gives a canonical
pair of each kind over the same game to keep that path honest.

A game whose start is unknown, or that has no moves yet, has no history to
carry and is shared as a position alone. So is a line too long to fit in
`MAX_SHARE_PARAM_CHARS`: the fallback is silent, since a long game still shares
something useful, and the `too-long` message then means what it says.

#### Playing from a cursor behind the end

If the recipient makes a move while the cursor is behind the end of the
history, the plies after the cursor are discarded and the new move is appended.
There is no variation tree. This matches how `moveLog` and the autosave already
behave, and it is why a resume-play link loses nothing by shipping truncated
history in the first place.

### 4.5 Extras block

This block is present only when flags bit 1 is set.

| Field | Bits | Meaning |
|---|---|---|
| `autoFlip` | 1 | the board-flip preference |
| view side | 1 | which colour sits at the bottom when `autoFlip` is off |
| mode | 1 | 0 is `human-ai`, 1 is `human-human` |
| `aiColor` | 1 | 0 is white, 1 is black. Meaningful only in `human-ai`. |
| level | 2 | 0 is `easy`, 1 is `zen`, 2 is `fun`, 3 is a decode error |

Timers, `ponderEnabled`, and the clock are not carried. They are the
recipient's own preferences. Remaining clock time is meaningless in an
asynchronous share.

### 4.6 Checksum

CRC-16/CCITT-FALSE, polynomial `0x1021`, init `0xFFFF`, big-endian, over all
preceding bytes.

Its job is to tell "this link got truncated" apart from "this position is
nonsense", so the error message can be useful. It is not a security measure.
Anyone can recompute it.

## 5. Decoding and the two failure modes

The two modes are deliberately different, because they call for different
responses.

### 5.1 Structural failure, cannot render

This covers a `?p=` value over the decoder's length cap (§7), malformed base64,
an unknown version byte, non-zero reserved flag bits, a bitstream that ends
early, a bitstream with more than 7 trailing bits, non-zero padding bits after
the last field, an out-of-range field, an escape carrying a value that fits in
the field it escaped from (§4.3 steps 6 and 9), and a CRC mismatch.

Rejecting non-zero padding is what makes the encoding canonical: one position
has exactly one payload. Without that, §8.1's byte-length and fixture
assertions would pass on an encoder that wrote junk into the tail.

Nothing coherent can be shown. The app reports the reason, for example "this
link looks incomplete or was created with a different version of Evochess". It
then falls back to the normal startup path, which is to resume the autosave or
start a new game.

### 5.2 Legality failure, render but no engine

Here the payload decodes cleanly, but it describes a position that could not
occur. The decoder checks:

- exactly one king of each colour;
- no pawn on rank 1 or rank 8;
- at most 9 pieces including the king per side;
- the side not to move is not in check, since otherwise the position is
  unreachable and the side to move could capture the king;
- a rook-locked bit only on a knight or bishop. This holds by construction, and
  is re-checked as a decoder invariant.
- en passant coherence. The skipped square is empty. The square the pawn came
  from is empty. The victim square holds a pawn of the right colour. For the
  evolved variant it holds a non-pawn piece of the right colour, which is the
  whole reason `epEvolved` exists. See `game.ts:61-73`.

The board is still rendered. A position someone wants to argue about is worth
showing even if it was hand-built. But three things follow.

First, engine search is disabled for the whole session of that game. Mode is
forced to `human-human`, the AI-level control is hidden, and the worker is
never asked to search. The search and NNUE code assume a well-formed position.
Feeding one an impossible board gives a wrong evaluation at best, and an
out-of-bounds read in the bitboard layer at worst.

Second, the reason codes are logged with `console.warn`, for example
`evochess: shared link failed legality check [TWO_WHITE_KINGS, PAWN_ON_RANK_8]`.
A report of "the link is weird" is then diagnosable from a screenshot of the
console.

Third, a non-blocking banner tells the user the position is unverified and the
computer opponent is unavailable for it.

chess.js rejects an invalid FEN outright. So the illegal-position path must
construct the game with `chess.load(fen, { skipValidation: true })`, which
chess.js ^1.4.0 supports.

A history link is never merely unverified. Its base has to be legal before the
line can be replayed at all, so an illegal base is a structural failure under
§5.1 (`HISTORY_ILLEGAL_BASE`), and so is a base that is legal but where some
move fails to apply (`HISTORY_REPLAY_FAILED`). The latter means the link
disagrees with this build's rules, which is exactly what the version byte
exists to catch, so it is reported as a version mismatch. Nothing about the
lockout applies to history links.

## 6. Loading a shared link

1. Read `?p=` before the autosave is read.
2. Decode. On structural failure, fall through to the normal startup path.
3. Build the game, replaying history if present, and stop the display at the
   ply cursor.
4. Do not touch the autosave. The recipient's in-progress game stays in
   `localStorage` under `evochess-save-v3`, and a "back to my game" control
   restores it. The shared game is held in memory only. Once the recipient
   makes a move it becomes the live game and normal autosaving resumes.
   Overwriting the old save at that point is expected, because the user chose
   to play.
5. Leave `?p=` in the address bar for now (§3). Strip it with
   `history.replaceState` at the moment the shared game becomes live in step 4,
   and retire the "back to my game" control at the same moment, since the
   autosave it pointed at has just been overwritten.

## 7. Size

| Link | Payload | `?p=` value |
|---|---|---|
| Opening-ish position, 18 pieces, no history | 27 B | 36 chars |
| Middlegame position, 14 pieces, no history | 25 B | 34 chars |
| Canonical Link 1, 11 plies (§8.1) | 50 B | 67 chars |
| Canonical Link 2, 12 plies (§8.1) | 52 B | 70 chars |
| 80-ply game | 180 B | 240 chars |

Add the length of the deployed origin and path to get the full URL. The
`?p=` values above are exact, computed from the bit accounting in §8.1; the
position-only rows are approximate because piece count varies.

That sits well inside every practical limit. Browsers handle 2 kB and more, and
chat clients handle far more. A position link is also short enough not to look
alarming when pasted.

At about 4000 plies the 12-bit ply count saturates, but that is not the binding
limit. A 4000-ply link is roughly 7.6 kB of payload and 10 kB of base64, well
past the 2 kB the paragraph above relies on. So the encoder's guard is a payload
byte cap, which bites at around 1000 plies, rather than a ply-count cap. Either
way it must refuse rather than truncate silently.

The decoder needs its own cap, set independently of the encoder's. `?p=` is
entirely attacker-controlled, and a multi-megabyte value would otherwise be
base64-decoded and bit-parsed on the main thread before any of §5's checks get
to run. Reject an over-long `?p=` as a structural failure (§5.1) before decoding
anything.

## 8. Testing

- **Round-trip property test.** Play N random legal Evochess games, reusing the
  random-game harness that validates the bitboard backend against
  `EvoChessGame`. At every ply, encode the position, decode it, and assert the
  result equals `serializeGame()` of the original, after normalizing both sides.
  That includes `rookCharges`, `rookLocked`, and `epEvolved`, which are the
  fields a FEN alone loses.

  Normalizing is required, not laziness. The codec is lossless about the
  position, not about the exact map contents. `game.ts` treats a rook with no
  `rookCharges` entry as fully charged, so a decoded game carries an explicit
  `5` where the original carried no entry at all, and §4.3 step 3 has the
  encoder drop stale entries besides. A raw field-for-field comparison would
  fail on a *correct* codec. So normalize both sides first: fill in charges for
  every rook on the board, and drop any entry no rook stands on. Then compare.
- **History round-trip.** Encode base plus full move list, decode, replay, and
  assert the final state equals the original game's state. Also assert the
  regenerated `moveLog` matches SAN for SAN.
- **Evolved en passant.** A dedicated case. A double pawn move evolves on the
  same move, the position is shared at exactly that ply, and after decoding the
  en passant capture is still available to the opponent. Also assert the
  reassembled FEN's en passant field is `-` and the opportunity lives in
  `epEvolved`, per §4.3 step 7. Then call `fen()` twice and assert the victim
  square still holds a minor piece, which is the assertion that actually fails
  if the field was reassembled mechanically.
- **Corruption.** For a flipped bit, a truncated string, a wrong version byte,
  a non-zero reserved flag, and a bad CRC: assert §5.1 behaviour, and assert
  the autosave is untouched.
- **Illegal positions.** Hand-built payloads for each legality rule. Assert the
  board renders, the engine is disabled, and the expected reason code is
  logged. Per the `seededNet` lesson in this project's memory, each check must
  be shown to fail when deliberately broken, not merely to pass.
- **Fixed vectors.** A handful of payload-and-expected-state pairs checked into
  the test file. An accidental encoding change then breaks a test, instead of
  passing a round-trip test that changed on both sides at once. §8.1 is the
  primary one.

### 8.1 Canonical vectors: `data/games/game1.txt`

This is the acceptance test for M1 and M2. The game is short, and it exercises
every evolutionary mechanism that a FEN cannot express.

```
1. e4    g5
2. d4    b6
3. g3=B  c6
4. Bb8   a6
5. Bc7   a5=B+
6. c3    g4
7. Bb8=R#
```

Thirteen plies, White mates. The move list below was replayed through
`EvoChessGame`, and every state assertion in this section is that replay's
output, not hand derivation. `moveLog` comes back as
`e4 g5 d4 b6 g3=B c6 Bb8 a6 Bc7 a5=B+ c3 g4 Bb8=R#`, matching the file
token for token, and `resultString()` is `Checkmate - White wins`.

#### Ply table

Square indices are `a1 = 0 … h8 = 63` per §4.3. Tags are per §4.4.

| Ply | Move | `from` | `to` | Tag | `applyMove` options |
|---|---|---|---|---|---|
| 1 | e4 | e2 = 12 | e4 = 28 | 0 | none |
| 2 | g5 | g7 = 54 | g5 = 38 | 0 | none |
| 3 | d4 | d2 = 11 | d4 = 27 | 0 | none |
| 4 | b6 | b7 = 49 | b6 = 41 | 0 | none |
| 5 | g3=B | g2 = 14 | g3 = 22 | 2 | `{ minorPromo: "b" }` |
| 6 | c6 | c7 = 50 | c6 = 42 | 0 | none |
| 7 | Bb8 | g3 = 22 | b8 = 57 | 0 | none |
| 8 | a6 | a7 = 48 | a6 = 40 | 0 | none |
| 9 | Bc7 | b8 = 57 | c7 = 50 | 0 | none |
| 10 | a5=B+ | a6 = 40 | a5 = 32 | 2 | `{ minorPromo: "b" }` |
| 11 | c3 | c2 = 10 | c3 = 18 | 0 | none |
| 12 | g4 | g5 = 38 | g4 = 30 | 0 | none |
| 13 | Bb8=R# | c7 = 50 | b8 = 57 | 3 | `{ rookPromo: true }` |

#### The two links needed now

Both are resume-play links, so history is truncated at the cursor and
`cursor = plyCount` (§4.4). Both carry the standard start as their explicitly
encoded base, and both arrive with the human to move, so loading must not
trigger an engine search.

**Link 1. The recipient plays Black's 6th move.**

- history: plies 1 to 11, `plyCount = 11`, `cursor = 11`
- extras: none. The block is still unbuilt (§9, M5), so the recipient's own
  mode, level and orientation stand, and `aiColor` is derived from the cursor.
- decoded position: `4k3/2Bppp1p/1pp5/b5p1/3PP3/2P5/PP3P1P/4K3 b - - 0 6`
- `minorRights` 0/0, `rookRights` 0/0, `pawnMoveProgress` 1/2,
  `minorMoveProgress` 2/0, `rookCharges` empty, `rookLocked` empty,
  `epEvolved` null, not in check

Assertion beyond the position: Black's `pawnMoveProgress` is 2, so *any* Black
pawn move earns a minor right and may spend it on that same move. Candidate
generation at the loaded position must therefore offer `g4=N` and `g4=B`
alongside plain `g4`. That is the earn-and-spend case fixed in `57a2b44`, and
loading it straight from a link is a cheap regression guard for it.

**Link 2. The recipient plays White's 7th move, `Bb8=R#`.**

- history: plies 1 to 12, `plyCount = 12`, `cursor = 12`
- extras: none, as for Link 1
- decoded position: `4k3/2Bppp1p/1pp5/b7/3PP1p1/2P5/PP3P1P/4K3 w - - 0 7`
- `minorRights` 0/1, `rookRights` 0/0, `pawnMoveProgress` 1/0,
  `minorMoveProgress` 2/0, `rookCharges` empty, `rookLocked` empty,
  `epEvolved` null, not in check

Assertion beyond the position: White's `minorMoveProgress` is 2 and
`rookRights` is 0. So playing `c7 → b8` earns the rook right on that move and
spends it on the same move. Afterwards `minorMoveProgress` is 0,
`rookRights` is 0, and `rookCharges` holds `{ b8: 5 }`. The move must be
offered as `Bb8=R`, it must be reported as `#`, and `isGameOver()` must be true
with `resultString()` equal to `Checkmate - White wins`. Note that the mate is
only mate *after* the evolution resolves, which is the ordering `rules.txt` §5
requires and `game.ts:399-405` implements.

Neither link contains ply 13. The mate is something the recipient plays, not
something the payload spoils.

#### The two scroll-through links

Same game, full 13-ply history, cursor pointing mid-game: Link 3 with
`plyCount = 13, cursor = 11`, Link 4 with `plyCount = 13, cursor = 12`. Their
decoded-at-cursor positions are identical to Link 1's and Link 2's above, which
is the property worth asserting: a truncated link and a full link that share a
cursor must produce the same board, the same rights, and the same counters.
Only the ability to scroll forward differs.

They needed no format change and no version bump. The work was the encoder
choosing a different `plyCount`/`cursor` pair, plus the browsing UI.

#### Exact sizes

The bit accounting is worth checking in the test, because a byte-length
assertion catches a bit-layout slip that a round-trip test cannot see. The base
is the standard start: 18 pieces, no rooks, no minor pieces, all counters zero,
so no rights escapes.

| Block | Bits | Note |
|---|---|---|
| occupancy | 64 | §4.3 step 1 |
| piece nibbles | 72 | 18 pieces x 4 |
| rook charges | 0 | no rooks in the base |
| rook-locked bits | 0 | no minor pieces in the base |
| side to move | 1 | white |
| evolution counters | 24 | 4 x 2 bits, then 4 x 4 bits, no escapes |
| en passant tag | 2 | tag 0 |
| halfmove clock | 7 | 0 |
| fullmove number | 8 | 1, no escape |
| **base position total** | **178** | |

| Link | History bits | Extras | Bitstream | Bytes | Payload | `?p=` chars |
|---|---|---|---|---|---|---|
| 1 | 12 + 11 x 15 + 12 = 189 | 0 | 367 | 46, 1 pad bit | 50 B | 67 |
| 2 | 12 + 12 x 15 + 12 = 204 | 0 | 382 | 48, 2 pad bits | 52 B | 70 |

Payload bytes are the bitstream bytes plus the version byte, the flags byte,
and the two CRC bytes. Every ply here is 15 bits, since no ply uses tag 6.
Flags byte is `0x01` for both links: history present, extras absent. base64url
character counts are `ceil(bytes * 4 / 3)` with padding stripped.

The encoded payloads themselves are deliberately not written into this document.
They are generated by the M1 encoder and checked into the test file as fixtures,
so the fixtures and the implementation cannot drift apart silently through a
copy-paste step.

## 9. Milestones

- **M1, codec.** `src/evochess/shareLink.ts` with `encodeShareLink(...)` and
  `decodeShareLink(...)`, plus §8's tests. Pure functions, no UI, no DOM. Done
  when §8.1's two links encode to the stated byte lengths and decode to the
  stated state.
- **M2, inbound links.** `?p=` parsing in `App.tsx`, the autosave-preserving
  load of §6, the unverified-position banner, and the engine lockout. Done when
  opening §8.1's Link 2 lets a human play `Bb8=R#` and see mate, and opening
  Link 1 offers `g4`, `g4=N`, and `g4=B`.
- **M3, outbound UI.** Shipped: a share button (mobile bar and desktop panel),
  using the Web Share API on mobile with a clipboard-copy modal as the fallback
  and the desktop default (see `docs/share-button-note.md`).
- **M4, move browsing and ply cursor.** Shipped. The board steps back and forth
  through the game, the Share button writes the ply on screen into the cursor
  field, and the whole line goes with it. A resumed game replays its own move
  tokens on load, so browsing and sharing-with-history survive a reload.
  Position-only remains the silent fallback when the start is unknown, when no
  move has been played, or when the line will not fit.
- **M5, extras block (§4.5).** Deferred. Orientation, mode and level are still
  not carried, so the recipient's own preferences win and `aiColor` is derived
  positionally from the cursor. Flags stays `0x01`, and the decoder already
  skips an extras block it does not need, so an encoder that later writes one
  will not break today's links.

## 10. Deferred, and not doing

- **Standard-start shortcut.** A flag meaning "the base is the standard
  opening" would save about 17 bytes on the common game link. It is rejected
  for now in favour of always encoding the base explicitly. That keeps one code
  path, and it lets a game that itself began from a shared position be shared
  with its history. It can be added later as a reserved-flag bit under a new
  version byte.
- **Captions.** Free text would cost URL length and would put attacker-supplied
  content into the UI. If it is added later, it must be rendered as plain text
  and never as HTML.
- **Short links.** Any `evoch.es/abc123` scheme needs a backend and a database.
  That is exactly what this design avoids.

## 11. Open, to revise later

None of these change the bit layout, so none of them block M1. They are written
down so they are decided deliberately rather than by whichever line of `App.tsx`
happens to run first.

- **Startup interactions with `App.tsx` are not specified.** Two are known. The
  first-visit tutorial invite is offered when no autosave exists
  (`App.tsx:291`), so a share link opened by a brand-new visitor gets the invite
  on top of the shared board. And takeback replays in-memory snapshots
  (`historyRef`, `App.tsx:78`), which a decode does not produce, so takeback
  will stop at the shared position unless replay pushes a snapshot per ply.
  Decide both in M2.
- **Extras override the recipient's own preferences.** §4.5 carries `level`,
  `autoFlip` and view side, so opening a link silently changes the recipient's
  difficulty and board orientation. Defensible for orientation, since the sharer
  is pointing at something. Harder to defend for `level`. Revisit when M3 builds
  the outbound UI and it becomes clear what a sharer thinks they are sending.
- **Line references drift.** Several citations here point at doc comments rather
  than the code implementing the behaviour: `game.ts:107-109` and
  `game.ts:61-73` are both comment blocks, the missing-entry-means-full-charges
  logic is at `game.ts:326`, and `game.ts:399-405` is the SAN suffix refresh,
  which sits next to the check-after-downgrade ordering §8.1 cites it for rather
  than being it. Re-anchor them once `shareLink.ts` exists and the surrounding
  line numbers stop moving.
