-- Narrows the browser's read of `puzzles` to the three columns it asks for.
--
-- Safe to re-run.

begin;

-- A table-level grant cannot be narrowed in place: it has to go first, or the
-- column grants below are a no-op on top of it.
revoke select on public.puzzles from anon;

grant select (publish_date, param, mate_in) on public.puzzles to anon;

commit;

-- Adding a column to `dailyPuzzle.ts`'s query now means adding it here too.
