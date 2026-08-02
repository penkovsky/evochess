-- Lets one game write more than one row, against a collector where
-- `game_uid` is still unique.
--
-- An abandon is reported as the tab goes away, and the browser cannot tell a
-- close from a phone switching apps. So the abandoned row has to be
-- supersedable: the player comes back, finishes, and a second row for the same
-- `game_uid` carries the real outcome. Uniqueness moves to a per-row key, which
-- is what was keeping a retried POST from double-inserting in the first place.
--
-- Read the table through the dedupe in `games.sql` afterwards, not raw.
--
-- Safe to re-run.

begin;

alter table public.games add column if not exists row_uid uuid;
-- Rows written before this migration are one-per-game, so any unique value
-- will do.
update public.games set row_uid = gen_random_uuid() where row_uid is null;
alter table public.games alter column row_uid set not null;

alter table public.games drop constraint if exists games_game_uid_key;
alter table public.games drop constraint if exists games_row_uid_key;
alter table public.games add constraint games_row_uid_key unique (row_uid);

-- `game_uid` was indexed by its unique constraint until a moment ago, and the
-- joins from `events` still need it.
create index if not exists games_game_uid_idx on public.games (game_uid);

grant insert (row_uid) on public.games to anon;

commit;
