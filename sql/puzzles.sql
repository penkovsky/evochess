-- One mate puzzle per UTC day.
--
-- The one table the browser may SELECT from. Rows are inserted out of band, by
-- hand, with the service key; nothing here generates or validates them, and
-- each row is taken on trust to hold a forced mate of the stated length.

create table if not exists public.puzzles (
  -- Primary key, so "one puzzle per day" is a schema invariant, and so the
  -- policy below is an index-friendly comparison on the key the query orders by.
  publish_date date primary key,
  param        text        not null,   -- a ?p= share-link payload; the whole position
  mate_in      smallint    not null check (mate_in between 2 and 5),
  source_id    text,                   -- provenance; the client never reads it
  mate_san     text,
  solution     text[],
  created_at   timestamptz not null default now()
);

alter table public.puzzles enable row level security;

grant select on public.puzzles to anon;

-- The whole security model. `VITE_TELEMETRY_KEY` ships in the bundle, so "the
-- data is remote" protects nothing on its own: this policy is what stops
-- anyone reading tomorrow's puzzle. It grants select on this one table —
-- `events` and `games` stay insert-only and that must not change.
create policy "published only" on public.puzzles
  for select to anon
  using (publish_date <= (now() at time zone 'utc')::date);

-- A puzzle attempt reaches `games` down the shared-position path, so without
-- this it would look like any other share-link game. Any query over shared-link
-- games has to exclude `puzzle_date is not null`.
alter table public.games add column if not exists puzzle_date date;
grant insert (puzzle_date) on public.games to anon;
