# NNUE Net-vs-Net Match Spec

Extend `training/match.ts` so it can play a challenger NNUE net against
**another** NNUE checkpoint, not just against material+PST. This closes a gap
both relabel specs already assume is filled:
`nnue-pst-relabel-spec.md` step 4 wants "net' vs the current depth-3-trained
net," and `nnue-iterative-relabel-spec.md`'s round loop wants "net_r vs
net_{r-1}" every round. Today `match.ts` hardcodes its two players as
`"nnue" | "hce"` — there is no way to load two different weight files into
one match.

## Design

**One tool, not two.** `match.ts` gains an optional `--opponent-weights
<path>` flag. Its absence preserves today's behavior exactly (challenger vs
material+PST); its presence swaps the opponent's leaf eval from material+PST
to the loaded net. Same flags, same defaults, same output shape either way —
a caller diffing old vs new match logs sees only the opponent's identity
change.

**Pairwise only.** One challenger vs one opponent per run, matching how both
relabel specs use it (`net'` vs baseline, `net_r` vs `net_{r-1}`). No
round-robin / multi-net tournament mode — out of scope, see Non-goals.

**Identical match conditions to today's net-vs-hce runs.** Same defaults:
40 games, 200ms/move, 4 random opening plies, 200-ply cap, 1.5-pawn cap
margin, color-alternated. This keeps net-vs-net results directly comparable
to the net-vs-hce numbers already on record — nothing about the contest
itself changes, only which evaluator sits in the second seat.

## Current shape (what's being generalized)

```ts
type Player = "nnue" | "hce";
// ...
setNnueWeights(player === "nnue" ? weights : null);
```

`playGame` toggles the module-level NNUE weights before each root search:
`"nnue"` loads the challenger's weights, `"hce"` clears them so `evaluate()`
falls back to material+PST. Everything else (opening randomization, timed
search, adjudication, depth tracking, Elo estimate) is player-shape-agnostic
already — it only ever asks "whose turn, which `Player` is that."

## New shape

Replace the `Player` union's meaning from "which eval function" to "which
weight set, or none":

```ts
type Player = "challenger" | "opponent";

interface Config {
  // ...existing fields unchanged...
  weightsPath: string;          // challenger's net-weights.json (required, as today)
  opponentWeightsPath: string | null; // opponent's net-weights.json; null = material+PST
}
```

`playGame` and the per-move toggle change from `player === "nnue" ? weights
: null` to a small lookup:

```ts
const evalFor: Record<Player, NnueWeights | null> = {
  challenger: challengerWeights,
  opponent: opponentWeights, // null when --opponent-weights was not passed
};
setNnueWeights(evalFor[player]);
```

`opponentWeights` is loaded once at startup, exactly like the challenger's,
guarded by whether `--opponent-weights` was passed:

```ts
const opponentWeights = cfg.opponentWeightsPath
  ? loadWeights(JSON.parse(readFileSync(cfg.opponentWeightsPath, "utf8")))
  : null;
```

No change to `searchRootTimed`, adjudication, or the opening-randomization
loop — the generalization is confined to "which weights are active for this
mover," which is exactly the one line the old code already isolated as a
toggle.

## CLI

```
--weights <path>            challenger's net-weights.json (default: training/checkpoints/net-weights.json, unchanged)
--opponent-weights <path>   opponent's net-weights.json (default: unset → material+PST, today's behavior)
--games / --time / --cap / --seed / --opening   unchanged, same defaults
```

No new flags beyond `--opponent-weights`. Labels in the summary output use
each path's basename (stripping directory and `.json`) so a log reads `net'
vs net-relabel-pst5` instead of a generic "nnue"/"hce", without requiring a
separate `--label` flag for the common case. `--opponent-weights` absent
still prints `material+PST` for the opponent label, matching today's output
text.

## Output

Same structure as today, generalized:

```
<challenger label> vs <opponent label> — 100 games at 200ms/move
result (challenger):   +54 -31 =15   score 61.5%
elo (challenger):      +81 ± 35
avg depth:      challenger 2.71  opponent 2.68  (equal time)
avg game:       118 plies
```

`elo()` is unchanged (it's already player-agnostic — takes a score and game
count). Only the printed labels and the `nnue`/`hce` field names in the
depth-tracking `Record` become `challenger`/`opponent`.

## Determinism

Unchanged: `mulberry32(cfg.seed)` drives opening-move sampling, per-move
search seeds are `cfg.seed + g * 100003 + ply`-derived exactly as today, and
color alternates by game index. A net-vs-net run with the same `--seed` is
exactly as reproducible as a net-vs-hce run is today — nothing about
determinism changes when the opponent switches from a fixed eval function to
a second loaded net.

## Procedure

```bash
# Bundle once (existing command, unchanged).
npx esbuild training/match.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=training/match.bundle.mjs

# Net' vs material+PST (today's mode — no --opponent-weights).
node training/match.bundle.mjs \
  --weights training/checkpoints/net-relabel-pst5-weights.json --games 100

# Net' vs the current depth-3-trained net (new mode).
node training/match.bundle.mjs \
  --weights training/checkpoints/net-relabel-pst5-weights.json \
  --opponent-weights training/checkpoints/net-weights.json --games 100
```

The second invocation is exactly what `nnue-pst-relabel-spec.md` step 4 and
`nnue-iterative-relabel-spec.md`'s per-round match both call for.

## Non-goals

- **Round-robin / multi-net tournaments.** Pairwise only. A caller wanting a
  full comparison across several checkpoints runs this pairwise, once per
  pair — no built-in tournament driver or Elo table.
- **Changing match conditions.** Game count, time control, opening
  randomization, and adjudication margins are unchanged from `match.ts`
  today; this spec only adds a second weight source, not new knobs on the
  contest itself.
- **A third "both nets, no HCE anywhere" mode beyond what `--opponent-weights`
  already gives.** There's nothing further to add — once both seats can hold
  either a net or `null` (material+PST), all three pairings (net-vs-hce,
  net-vs-net, and, trivially but uselessly, hce-vs-hce) are already
  reachable with these two flags.

## Success criterion

`training/match.ts --opponent-weights <path>` runs a net-vs-net match and
prints the same shape of result `match.ts` already prints for net-vs-hce.
With `--opponent-weights` omitted the output keeps today's structure
line-for-line — same lines, same fields, same number formats — with only the
labels updated to the basename/`challenger`/`opponent` scheme this spec
introduces (e.g. `NNUE vs material+PST` becomes `<challenger> vs
material+PST`, `result (net):` becomes `result (challenger):`). This is a
structural round-trip, not a byte-identical one: old callers and any log
parser keyed on field structure keep working, but a parser matching the
literal old labels must be updated.
