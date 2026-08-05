import { useState } from "react";
import { markSeen } from "../evochess/tutorialProgress";

export interface UseTutorialInvite {
  showTutorial: boolean;
  setShowTutorial: (open: boolean) => void;
  /** Whether the first-visit offer is on screen. */
  showInvite: boolean;
  offerInvite: () => void;
  /** Someone who has started playing has answered the question the offer asked. */
  dismissInvite: () => void;
  openTutorial: () => void;
}

export interface UseTutorialInviteArgs {
  /**
   * The tutorial is about to use the worker for its own opponent, so a ponder
   * chain on this game's position is now both stale and in the way
   * (ponder-spec.md §5.3, §6.2).
   */
  resetPonder: () => void;
}

/**
 * The onboarding offer and the tutorial it opens. The rules are the whole point
 * of the variant and take longer to read than a first-time visitor will give
 * us, so a first visit offers the tutorial beside a live board rather than in
 * front of it. The offer never blocks play: making a move dismisses it.
 */
export function useTutorialInvite({ resetPonder }: UseTutorialInviteArgs): UseTutorialInvite {
  const [showTutorial, setShowTutorial] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  function dismissInvite() {
    if (!showInvite) return;
    setShowInvite(false);
    markSeen();
  }

  function openTutorial() {
    resetPonder();
    setShowInvite(false);
    setShowTutorial(true);
  }

  return {
    showTutorial,
    setShowTutorial,
    showInvite,
    offerInvite: () => setShowInvite(true),
    dismissInvite,
    openTutorial,
  };
}
