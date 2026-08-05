import { useRef, useState, type RefObject } from "react";

export interface UseEngineLockout {
  /**
   * A position that could not have occurred (share-links-spec.md §5.2). The
   * board is still shown; the engine is not allowed near it, and the pickers
   * fall back to human-vs-human.
   */
  unverified: boolean;
  /**
   * The same fact, readable from a timer callback. `maybeAiMove` and
   * `maybeStartPonder` run from `setTimeout` holding a closure over state React
   * may not have flushed yet, and the lockout must not depend on that timing:
   * the search and NNUE assume a well-formed board, and an impossible one risks
   * an out-of-bounds read in the bitboard layer.
   */
  engineLockedRef: RefObject<boolean>;
  setLockout: (locked: boolean) => void;
}

/**
 * Whether the engine is allowed near the position on the board. Declared ahead
 * of both the worker and the shared-position handover, because both need it and
 * neither owns it.
 */
export function useEngineLockout(): UseEngineLockout {
  const [unverified, setUnverified] = useState(false);
  const engineLockedRef = useRef(false);

  function setLockout(locked: boolean) {
    engineLockedRef.current = locked;
    setUnverified(locked);
  }

  return { unverified, engineLockedRef, setLockout };
}
