export function TopBanners({
  linkNotice,
  sharedPending,
  unverified,
  sharedStatusText,
  hasSavedGame,
  puzzleActive,
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
          <p>{linkNotice ?? sharedStatusText}</p>
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
