import { decodeShareLink, readShareParam, type ShareDecodeSuccess } from "../../evochess/shareLink";
import { readMatchParam } from "../../liveMatch";
import type { LoadedGame } from "../../evochess/persistence";
import type { DailyPuzzle } from "../../evochess/dailyPuzzle";
import type { TutorialProgress } from "../../evochess/tutorialProgress";

/**
 * Which of the four sources takes the board at mount.
 *
 * Only three can: `?lm=` and `?daily` arrive later (one from the network, one
 * from a timer, see `Startup.match` and `Startup.puzzle`), so at mount the
 * board still holds the autosave, or nothing.
 */
export type StartupBoard =
  | { kind: "shared"; link: ShareDecodeSuccess; param: string }
  | { kind: "resume"; saved: LoadedGame }
  | { kind: "fresh"; offerTutorial: boolean };

export interface Startup {
  /**
   * The autosave, when there is one, whether or not it takes the board: it
   * carries the player's own settings, which apply to whichever game wins
   * (share-links-spec.md §4.5). Applied before the board claim.
   */
  settings: LoadedGame | null;
  board: StartupBoard;
  /** A refused link's user-facing message, or null. */
  notice: string | null;
  /** A refused link's structural code, to log. Null when nothing was refused. */
  refusedCode: string | null;
  /** `?lm=`: the match to open. It claims the board when its response lands. */
  match: string | null;
  /**
   * `?daily`: the flag to strip from the URL, and the fetch to fire. Never set
   * alongside a `?p=` link, which wins as the more specific of the two.
   */
  daily: boolean;
  /**
   * The cached puzzle, when `?daily` asked for one and the cache had it. It
   * claims the board on a timer, after everything here has been applied.
   */
  puzzle: DailyPuzzle | null;
  /** `page_load` telemetry, derived from the same reads. */
  fromShare: boolean;
  shareRefused: boolean;
  /** Whether the autosave is what the player is looking at. */
  resumed: boolean;
}

export interface StartupInputs {
  /** `window.location.search`. */
  search: string;
  /** The autosave, already read. */
  saved: LoadedGame | null;
  /** The cached puzzle, already read. */
  cache: DailyPuzzle | null;
  progress: TutorialProgress;
}

/**
 * Decides what a page load holds, from the four sources that contend for the
 * board. Pure: every read is passed in, and nothing here touches the DOM, the
 * URL or storage. The apply step in `App.tsx` acts on the result in order.
 *
 * The precedence, which is the whole point of this function:
 *
 * - `?p=` wins over everything, being the most specific.
 * - `?daily` is ignored under `?p=`, and otherwise claims the board later.
 * - `?lm=` never claims the board here; it is fetched.
 * - The autosave holds the board under `?daily` and `?lm=`, until they land.
 * - The tutorial invite is offered only on a bare load with nothing to show.
 */
export function resolveStartup({ search, saved, cache, progress }: StartupInputs): Startup {
  const param = readShareParam(search);
  const link = param ? decodeShareLink(param) : null;
  // Read before the flag is stripped from the URL, and only when no `?p=` is
  // present, so the more specific of the two wins.
  const daily = !param && new URLSearchParams(search).has("daily");
  const match = readMatchParam(search);
  const refused = !!link && !link.ok;
  // A valid link takes the board, and the autosave is left where it is.
  const resumed = !!saved && !link?.ok;

  let board: StartupBoard;
  if (link?.ok) board = { kind: "shared", link, param: param! };
  else if (saved) board = { kind: "resume", saved };
  else {
    // Deliberately not offered on top of a shared board (spec §11), nor over a
    // puzzle or a match about to arrive on one: someone arriving on a link came
    // to look at a position, and the invite would cover it.
    board = { kind: "fresh", offerTutorial: !daily && !match && !progress.seen };
  }

  return {
    settings: saved,
    board,
    notice: link && !link.ok ? link.message : null,
    refusedCode: link && !link.ok ? link.code : null,
    match,
    daily,
    puzzle: daily ? cache : null,
    fromShare: !!param,
    shareRefused: refused,
    resumed,
  };
}
