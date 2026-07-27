import type { AiLevel } from "./ai";

const STORAGE_KEY = "evochess-scores-v1";

export interface ScoreRecord {
  wins: number;
  losses: number;
  draws: number;
}

export type Scores = Record<AiLevel, ScoreRecord>;

function emptyRecord(): ScoreRecord {
  return { wins: 0, losses: 0, draws: 0 };
}

export function loadScores(): Scores {
  const raw = localStorage.getItem(STORAGE_KEY);
  const scores: Scores = { easy: emptyRecord(), zen: emptyRecord(), fun: emptyRecord() };
  if (!raw) return scores;
  try {
    const parsed = JSON.parse(raw) as Partial<Scores>;
    for (const level of ["easy", "zen", "fun"] as AiLevel[]) {
      if (parsed[level]) scores[level] = { ...emptyRecord(), ...parsed[level] };
    }
  } catch {
    // Ignore corrupt data — fall back to empty scores.
  }
  return scores;
}

export function saveScores(scores: Scores) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
}

export function recordResult(level: AiLevel, outcome: "win" | "loss" | "draw"): Scores {
  const scores = loadScores();
  const record = scores[level];
  if (outcome === "win") record.wins += 1;
  else if (outcome === "loss") record.losses += 1;
  else record.draws += 1;
  saveScores(scores);
  return scores;
}
