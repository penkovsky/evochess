export function TopBanners({
  linkNotice,
  sharedPending,
  unverified,
  sharedStatusText,
  hasSavedGame,
  puzzleActive,
  openPuzzleList,
  onOlderPuzzle,
  onNewerPuzzle,
  setLinkNotice,
  backToMyGame,
  parked,
  showInvite,
  openTutorial,
  dismissInvite,
}: {
  linkNotice: string | null;
  sharedPending: boolean;
  unverified: boolean;
  sharedStatusText: string;
  hasSavedGame: boolean;
  /**
   * Whether a puzzle owns the board. It outlives `sharedPending`, which the
   * solver's first move clears. The banner is where the day it is for gets
   * said. So the banner has to outlive it too.
   */
  puzzleActive: boolean;
  /** Opens the history. Null when there is no puzzle on the board to open it from. */
  openPuzzleList: (() => void) | null;
  /** A day back. Null at the oldest puzzle the history reaches. */
  onOlderPuzzle: (() => void) | null;
  /** A day on. Null on today's, which is always the newest there is. */
  onNewerPuzzle: (() => void) | null;
  setLinkNotice: (notice: string | null) => void;
  backToMyGame: () => void;
  parked: boolean;
  showInvite: boolean;
  openTutorial: () => void;
  dismissInvite: () => void;
}) {
  return (
    <>
      {/* Everything a shared link has to say, in one banner: on a phone this
          sits between the top of the page and the board, so a second one would
          push the board under the fold. Non-blocking either way. */}
      {(linkNotice || sharedPending || unverified || puzzleActive) && (
        <div className={`link-banner${unverified ? " unverified" : ""}`} role="status">
          {/* The day it is for doubles as the way to the other days: a step
              either side for the neighbours, the label itself for the list.
              This is the only route to them, so it must not disappear behind a
              notice. */}
          {!linkNotice && openPuzzleList ? (
            <div className="puzzle-nav">
              <button
                type="button"
                className="puzzle-step"
                aria-label="Previous puzzle"
                disabled={!onOlderPuzzle}
                onClick={onOlderPuzzle ?? undefined}
              >
                ‹
              </button>
              <button type="button" className="puzzle-banner-btn" onClick={openPuzzleList}>
                {sharedStatusText} <span aria-hidden="true">▾</span>
              </button>
              {/* Never enabled on today's: there is no tomorrow to reach. The
                  policy on `puzzles` caps the query at today, which is what
                  stops anyone reading ahead. */}
              <button
                type="button"
                className="puzzle-step"
                aria-label="Next puzzle"
                disabled={!onNewerPuzzle}
                onClick={onNewerPuzzle ?? undefined}
              >
                ›
              </button>
            </div>
          ) : (
            <p>{linkNotice ?? sharedStatusText}</p>
          )}
          {linkNotice ? (
            <button className="invite-skip-btn" onClick={() => setLinkNotice(null)}>
              Dismiss
            </button>
          ) : (
            (sharedPending || puzzleActive) &&
            hasSavedGame && (
              <button className="invite-skip-btn" onClick={backToMyGame}>
                Back to my game
              </button>
            )
          )}
        </div>
      )}
      {/* Once the shared game is live the offer stays, but as a single compact
          button rather than a banner: it has to survive the whole game, and a
          banner above the board that long is space the board needs on a phone.
          Not while a puzzle is on the board: the banner above is still up, and
          it is already carrying the same button. */}
      {!sharedPending && !puzzleActive && parked && (
        <div className="parked-game-row">
          <button className="parked-game-btn" onClick={backToMyGame}>
            ↩ Back to my game
          </button>
        </div>
      )}
      {/* Sits above the board rather than inside the panel: on a phone the
          panel is below the board, which would put the offer under the fold
          for exactly the visitors who most need it. */}
      {showInvite && (
        <div className="tutorial-invite">
          <div className="tutorial-invite-text">
            <h2>New to Evochess?</h2>
            <p>
              It's chess, but start with Pawns and a King. Other pieces you
              earn. Three-minute lesson, or just start playing.
            </p>
          </div>
          <div className="tutorial-invite-actions">
            <button className="learn-btn" onClick={openTutorial}>
              Show me how
            </button>
            <button className="invite-skip-btn" onClick={dismissInvite}>
              No thanks
            </button>
          </div>
        </div>
      )}
    </>
  );
}
