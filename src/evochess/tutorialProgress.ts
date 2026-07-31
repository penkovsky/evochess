import { track } from "../telemetry";
import { LESSONS } from "./tutorial";

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

/**
 * One row per real advance. Fired from the writers rather than from `save()`,
 * so `resetProgress` is not logged as a fresh start.
 */
function trackProgress(progress: TutorialProgress, lessonId: string | null, opened: boolean) {
  track("tutorial_progress", {
    lesson_id: lessonId,
    lessons_done: progress.completed.length,
    // So a later lesson being added leaves the old rows interpretable.
    total_lessons: LESSONS.length,
    opened,
  });
}

/**
 * The tutorial was opened. Deliberately not fired from `markSeen`, whose other
 * caller is the invitation being dismissed: someone who declines the tutorial
 * and starts playing has not started it, and one row cannot mean both. Fired on
 * every open, not only the first, since `seen` goes true after the first one.
 */
export function trackTutorialOpened(progress: TutorialProgress) {
  trackProgress(progress, null, true);
}

export function markSeen(): TutorialProgress {
  const progress = loadProgress();
  if (progress.seen) return progress;
  progress.seen = true;
  save(progress);
  return progress;
}

export function markCompleted(lessonId: string): TutorialProgress {
  const progress = loadProgress();
  const already = progress.completed.includes(lessonId);
  if (!already) progress.completed.push(lessonId);
  progress.seen = true;
  save(progress);
  // Redoing a finished lesson is not progress.
  if (!already) trackProgress(progress, lessonId, false);
  return progress;
}

export function resetProgress(): TutorialProgress {
  return save({ completed: [], seen: true });
}
