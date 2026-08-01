-- Daily puzzle migration, against a collector that already has `events` and
-- `games`.
--
-- Safe to re-run: every statement is either `if not exists` or a drop-then-add.

begin;

-- 1. The three puzzle event names. The check constraint on the live table was
-- created before they existed, so without this every puzzle_* insert is
-- rejected, and telemetry fails silently, so nothing would say so.
alter table public.events drop constraint if exists events_name_known;
alter table public.events
  add constraint events_name_known check (name in (
    'page_load', 'first_move', 'game_start', 'game_end', 'game_abandon',
    'tutorial_progress', 'share_open', 'share_copy',
    'puzzle_open', 'puzzle_solved', 'puzzle_failed'
  ));

-- 2. The tag that keeps puzzle attempts out of the shared-link game numbers.
alter table public.games add column if not exists puzzle_date date;
grant insert (puzzle_date) on public.games to anon;

-- 3. The one table the browser may SELECT from.
create table if not exists public.puzzles (
  publish_date date primary key,
  param        text        not null,
  mate_in      smallint    not null check (mate_in between 2 and 5),
  source_id    text,
  mate_san     text,
  solution     text[],
  created_at   timestamptz not null default now()
);

alter table public.puzzles enable row level security;

grant select on public.puzzles to anon;

-- This is what stops anyone reading tomorrow's
-- puzzle, since the key ships in the bundle.
drop policy if exists "published only" on public.puzzles;
create policy "published only" on public.puzzles
  for select to anon
  using (publish_date <= (now() at time zone 'utc')::date);

commit;
