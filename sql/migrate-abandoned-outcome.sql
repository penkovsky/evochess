-- Adds 'abandoned' to games.outcome, against a collector whose
-- games_outcome_known constraint predates it.
--
-- Safe to re-run: drop-then-add.

begin;

alter table public.games drop constraint if exists games_outcome_known;
alter table public.games
  add constraint games_outcome_known check (outcome in ('win', 'loss', 'draw', 'timeout', 'abandoned'));

commit;
