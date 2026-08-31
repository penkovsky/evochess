# Clip tool

Turns an Evochess position or game into a vertical video, ready for a light
edit and an upload.

```
npx esbuild scripts/makeClip.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=scripts/makeClip.bundle.mjs
node scripts/makeClip.bundle.mjs clips/tutorial-2.json
```

Input is one manifest file. Output is one mp4, 1080x1920, silent, at
`clips/out/`. A dev server is started and stopped for the run unless
`--base <url>` points at one already running.

## 1. How it works

Frames are screenshots of the real app. Nothing about the board is
re-implemented, so piece art, evo strips, rook charge badges and colours are
whatever the app currently does, and the clip doubles as a look at the product.

The clip is replayed through the rules engine in Node, encoded as a single
`?p=` link carrying the whole line, and opened once. From there the tool steps
the app's own history browsing with ArrowRight, screenshotting each ply.

One link for the line rather than one link per ply is not an optimisation. A
share link hands the recipient the side to move (`App.tsx`, "the recipient
always moves first"), so a link per ply would flip the board on every ply.
Opening once at ply 0 fixes the orientation for the whole clip. It also means
the board orientation is not a manifest setting: it follows from who is to move
at the first ply of the line, which is White for a game from the opening and
for a clip that starts on a White move.

## 2. The manifest

JSON, one file per clip, under `clips/`. A clip is a start state, a move line,
and presentation.

```json
{
  "out": "out/game2.mp4",
  "moves": "../data/games/game2.txt",
  "evals": "../data/games/game2-annotated.tsv",
  "evalColumn": "net-relab4-d5.search",
  "titleCard": "A knight that arrives as a rook",
  "captions": { "26": "The knight evolved to a rook, with check.", "43": "Mate." },
  "finalHold": 3500,
  "endCard": "evochess.org"
}
```

Paths are relative to the manifest. Every field is optional except a move
source.

| Field | Meaning |
| --- | --- |
| `out` | Output path. Defaults to the manifest name with `.mp4`. |
| `fen` + `evo` | A hand-built start state. `evo` carries the evolution state a FEN cannot. |
| `p` | A `?p=` payload or a whole share URL, instead of `fen` + `evo`. |
| `moves` | Path to a numbered SAN move list. `#` lines are comments. |
| `line` | Inline SAN, as an alternative to `moves`. |
| `from`, `to` | First and last ply shown. Earlier plies are still replayed, so the position is right. |
| `evals` | Path to a TSV from `training/annotate_game.ts`. Turns the eval bar on. |
| `evalColumn` | Which TSV column drives the bar, e.g. `net-relab4-d5.search`. |
| `captions` | Ply number to caption text. Sparse. A clip with no captions is normal. |
| `hold` | Ply number to milliseconds. Overrides every automatic dwell for that ply. |
| `dwell` | Base milliseconds per ply. Default 600. |
| `captionHold` | How long the caption beat holds. Default 2600. |
| `swing`, `swingHold` | Eval jump in pawns that earns extra time, and how much. Default 1.5 and 2000. |
| `finalHold` | Floor for the last board frame. Default 2500. |
| `images` | Pictures cut in as full-screen cards. See below. |
| `titleCard`, `titleHold` | Opening card and its duration. Omit for none. |
| `titleGradient` | Generated colour background for the title card. `true`, or a seed number. |
| `titleGlyph` | Large text under the title, e.g. a chess glyph. |
| `titleGlyphColor` | CSS colour for `titleGlyph`. Defaults to the card's white. |
| `logo` | Brand the cards with the site mark. Default off. |
| `endCard`, `endHold` | Closing card and its duration. Omit for none. |
| `endGradient` | Generated colour background for the end card. `true`, or a seed number. |
| `animate` | Slide pieces to their squares. Default true. |
| `animationMs` | How long a piece takes to cross. Default 250. |
| `speed` | Whole-clip pace. 2 is twice as fast, 0.5 half. Default 1. |
| `speeds` | Pace over a ply range, e.g. `{"0-12": 2}`. Multiplies with `speed`. |
| `baseUrl` | Serve from here instead of starting a dev server. |
| `fps` | Default 30. |

The start state is `p` or `fen` when given, otherwise the standard opening.
Giving both is an error.

`p` takes a share link, so a position you found in the app becomes a clip by
pasting it. A link that carries history brings its move line with it, and
`moves` or `line` still carry on from wherever it ends. An unverified position
is rendered with a warning rather than refused.

The link's cursor becomes the default `from`, so a link shared while browsing
at a moment starts the clip there. A cursor sitting at the end of the line is
what sharing a whole game produces and means no particular moment, so those
start at ply 0 instead. `from` in the manifest overrides either way.

**Ply numbers count positions, not moves.** Ply 0 is the start, ply *n* is the
position *after* the *n*th move. A caption about what a move did belongs on the
ply after it. The eval TSV uses the same convention, so a row lines up with the
frame directly.

## 3. Pacing

A ply is one beat of `dwell`, stretched by whichever of these applies:

- an explicit `hold` entry, which wins outright,
- an eval jump of `swing` pawns or more against the previous ply,
- being the last ply, floored at `finalHold`.

Every one of these is scaled by `speed`, including the explicit `hold` and
`finalHold` entries: they are the duration before pacing, not after. At
`speed: 2` a `finalHold` of 5000 puts 2500ms on screen.

A captioned ply is **two** beats: the move lands and holds clean for its dwell,
then the caption appears over the position for `captionHold`. The viewer sees
the move, then reads about it, rather than the move arriving under the text.

A move also costs `animationMs` of flight before the ply it lands on.

`speed` scales the whole clip, and `speeds` scales a ply range on top of it, so
`{"speed": 1.4, "speeds": {"40-43": 0.7}}` rushes the game but lets the finish
breathe. Both are speeds, not durations: a bigger number is faster. Overlapping
ranges multiply. Speed changes the *number* of animation sub-frames rather than
their length, so every frame stays on the output grid.

With `speed: 1.4` and two slowed ranges, `game2.json` lands at 41.1s over 241
frames. `tutorial-2.json` runs unscaled at 22.8s over 31.

Every frame paints its own overlay rather than inheriting the last one. An
animation frame that kept the previous frame's overlay slides its piece out
from under a caption that should already have gone, and the travelling square
out-stacks the scrim and drags a bright trail across it. That is why the scrim,
the dim and the caption all sit above the z-index a travelling square is lifted
to.

## 3a. Animation

Pieces slide rather than cut. The board component's own animation is not usable
for this: it runs on wall-clock time, so frames would land wherever the
screenshots happened to fall. Instead the tool places the piece itself. For
each output frame of flight it takes the board of the ply *before* the move and
translates the piece on the origin square a fraction of the way to the
destination, so every frame is exact and the clip is reproducible.

Drawing the move on the position before it is also what makes an evolution read
correctly: the bishop travels as a bishop, and the rook only appears when it
lands. The travelling square is lifted with a z-index, because squares later in
the grid paint over earlier ones and would otherwise bury a piece moving
up-board. The rook charge badge and the downgrade dot travel with the piece.

## 4. Composition

Overlays are built in the page before the screenshot, so one screenshot is one
finished frame and ffmpeg only concatenates. The design is CSS, which can be
opened in a browser, rather than an ffmpeg filtergraph.

The viewport is 540x960 at a device scale factor of 2, which is both the
1080x1920 output and narrow enough to put the app in its phone layout.

Top to bottom: a 200px margin; the board with both evo strips; a horizontal
eval bar with its signed label above it; and a 200px footer margin left clear
of the TikTok chrome. The equal margins are what keep the board centred.
Everything that is interface rather than position is hidden by the injected
stylesheet: the side panel, the mobile bar, the action picker, the status line,
banners, sheets and the score, puzzle and live overlays.

A caption is centred over the board, with a scrim dimming the board behind it.
The scrim spans the same band as the board, so the eval bar underneath stays
lit and the clip does not appear to cut to black.

Cards are the same frame with the board covered.

`titleGradient` puts a generated colour background behind the title card.
`true` seeds it from the title text, a number seeds it explicitly, so changing
the number rerolls the colours. It is always deterministic: the same manifest
renders the same clip.

`logo` brands the cards from `public/favicon.svg`. The end card gets a large
app-icon tile, a dark rounded square with the mark inset, above its text. Image
cards get the same tile small in the top-left corner as a watermark, so a
picture pulled out of the clip still carries the mark. The title card is left
alone: it has `titleGlyph`. Board frames are never touched, so the position
stays clean.

To pick a seed by eye instead of guessing, generate a contact sheet:

```
npx esbuild scripts/gradientSheet.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=scripts/gradientSheet.bundle.mjs
node scripts/gradientSheet.bundle.mjs 100
```

That writes `clips/out/gradients.html`: 100 swatches, each shaped and typeset
like a real title card and labelled with its seed. Click one to copy it.
`--from N` shifts the range and a leading number changes the count.

`endGradient` works the same way for the closing card. With `true` the two
cards get different colours, since each is seeded from its own text; pass both
the same number to make them match.

`titleGlyphColor` takes any CSS colour. Nothing checks it against the gradient
behind it, so a glyph in the brand green on a green-ish gradient will be low
contrast. White is the readable default.

`titleGlyph` is any string, set at display size under the title. It is meant
for a character or two, e.g. `"♟"` for a pawn. There is no colour emoji font in
the render container, so emoji come out as monochrome outlines; the chess
glyphs render as solid shapes and read much better.

The colours are picked in OKLCH and, more importantly, *interpolated* in OKLCH.
Two hues far apart mixed in sRGB pass through grey, which is what makes a naive
random gradient muddy; in OKLCH the midpoint stays saturated. Lightness is held
between 0.46 and 0.64 so white title text stays readable over every stop, and
the corner glow fades to its own colour at zero alpha rather than to
`transparent`, which is transparent *black* and would dirty the fade.

## 4a. Images

`images` is a list, each entry a picture shown full-screen with the board
hidden, the way the title and end cards are. Paths are relative to the
manifest; `clips/img/` is the usual place.

```json
"images": [
  { "src": "img/cat-shock.png", "at": 2, "when": "after", "hold": 900 },
  { "src": "img/cat-dead.png", "at": "end" }
]
```

`at` is a ply number, or `"start"` / `"end"` for the ends of the line. `when`
is `before` or `after`, default `after`: `after` follows that ply's board beat
and its caption beat, so a reaction lands on the reaction rather than on the
move. `before` goes ahead of the move into that ply. Entries sharing an anchor
keep their manifest order. `hold` defaults to 1200ms and is scaled by `speed`,
like the cards.

The file is read and inlined as a `data:` URI, because the page is served by a
dev server that knows nothing about the manifest's directory. PNG, JPEG, GIF,
WebP and SVG are accepted, and a missing file fails before the browser starts.
An animated GIF will show its first frame only: every frame here is a
screenshot.

## 5. Two things that bite

**The engine must not touch the position.** A shared link with the AI to move
gets a move played on it about a second after load, which would land in the
middle of a clip. The tool routes `ai.worker` to an empty script: the worker
constructs cleanly and never answers, so no move is ever made. The route is
matched case-sensitively and with the dot, or it also swallows
`useAiWorker.ts` and the app fails to mount.

**The status line updates before the board does.** Pieces arrive on the board
component's own schedule, which the injected stylesheet does not reach, and
screenshotting on the status line alone catches a square with a rook's charge
badge and no rook on it. So each frame waits until the set of occupied squares
matches the position the engine computed for that ply. Every move in this game
vacates its origin square, so that set changes on every ply, which makes it
enough to tell one ply from the one before it. A fixed sleep would work most of
the time, which is worse.

## 6. Worked example, tutorial 2

The position from the "Minors earn Rooks" lesson, played out to the mate the
lesson stops short of. Short, and it shows the one rule that makes Evochess not
chess.

```json
{
  "out": "out/tutorial-2.mp4",
  "fen": "5k2/4ppp1/6q1/8/8/8/3r2B1/4K3 w - - 0 1",
  "evo": { "minorMoveProgress": { "w": 2 }, "rookCharges": { "d2": 4 } },
  "line": "1. Ba8=R+ Rd8 2. Rxd8#",
  "titleCard": "A bishop that arrives as a rook",
  "dwell": 1400,
  "captions": {
    "0": "A bishop against a queen and a rook. Two of three blue dots are filled.",
    "1": "It travelled as a bishop and landed as a rook",
    "2": "Black blocks with a rook",
    "3": "Take the blocker. Mate."
  },
  "finalHold": 3500,
  "endCard": "evochess.org"
}
```

`evo` is what a FEN cannot say: White is two blue dots into its next Rook, and
the black rook on d2 is down to four charges. Without it the bishop would not
be able to arrive as a rook at all.

The manifest is deliberately self-contained rather than reading the lesson out
of `LESSONS`. A published clip should not change because the tutorial's prose
or move line was edited, and every caption here is hand-written anyway, so
there was nothing left for the lesson to supply.

31 frames, 22.8s: a title card, four plies with a caption beat each, and an end
card.

## 7. Layout

| File | Holds |
| --- | --- |
| `scripts/lib/replay.ts` | Matching a written SAN token to a move, and replaying a line. Shared with `shareGame.ts` and `gameToShareLinks.ts`, which used to carry a copy each. |
| `scripts/lib/clipManifest.ts` | The manifest, the eval TSV, and the frame list. Pure: reads files, returns data, knows nothing about browsers. |
| `scripts/makeClip.ts` | The dev server, the browser, the overlay CSS, and ffmpeg. |
| `clips/*.json` | The manifests. `clips/out/` is generated and ignored. |

## 8. Out of scope

- Audio. The clips are silent, and music goes on in the TikTok editor.
- Narration and text to speech.
- Uploading. The tool writes an mp4 and stops.
- Choosing which moments are interesting, beyond the eval-swing heuristic.
  Curation is the manifest's job.
