const STORAGE_KEY = "evochess-tutorial-v1";

export interface TutorialProgress {
  /** Ids of lessons the learner has finished. */
  completed: string[];
  /**
   * Whether the tutorial has ever been opened. First-time visitors are shown
   * it automatically (App.tsx), and this makes that happen exactly once —
   * dismissing it counts, so nobody is offered it twice.
   */
  seen: boolean;
}

const EMPTY: TutorialProgress = { completed: [], seen: false };

export function loadProgress(): TutorialProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<TutorialProgress>;
    return {
      completed: Array.isArray(parsed.completed) ? parsed.completed.filter((id) => typeof id === "string") : [],
      seen: !!parsed.seen,
    };
  } catch {
    // Ignore corrupt data — fall back to no progress.
    return { ...EMPTY };
  }
}

function save(progress: TutorialProgress): TutorialProgress {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Progress is a nicety; a full or blocked localStorage shouldn't break the
    // tutorial itself.
  }
  return progress;
}

export function markSeen(): TutorialProgress {
  const progress = loadProgress();
  if (progress.seen) return progress;
  progress.seen = true;
  return save(progress);
}

export function markCompleted(lessonId: string): TutorialProgress {
  const progress = loadProgress();
  if (!progress.completed.includes(lessonId)) progress.completed.push(lessonId);
  progress.seen = true;
  return save(progress);
}

export function resetProgress(): TutorialProgress {
  return save({ completed: [], seen: true });
}
