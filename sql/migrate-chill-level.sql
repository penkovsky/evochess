-- Adds 'chill' to games.level
--
-- Safe to re-run: drop-then-add.

begin;

alter table public.games drop constraint if exists games_level_known;
alter table public.games
  add constraint games_level_known check (level is null or level in ('chill', 'easy', 'zen', 'fun'));

commit;
