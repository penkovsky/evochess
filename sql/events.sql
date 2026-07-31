-- Same deal as `games`: the browser holds the anon key and may only INSERT.
-- Joined to `games` on `game_uid`.

create table if not exists public.events (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),  -- server clock, authoritative
  event_uid    uuid not null unique,   -- client-minted, so a retry cannot double-insert
  client_ts    timestamptz not null,   -- client clock, for deltas only
  anon_id      uuid not null,          -- per-browser, from localStorage
  session_id   uuid not null,          -- per-tab, from sessionStorage
  app_version  text not null,          -- git sha
  name         text not null,
  game_uid     uuid,                   -- null for events not about a game
  props        jsonb not null default '{}'
);

-- Every query orders by created_at. Never by client_ts: a wrong system clock
-- would poison the timeline.
create index if not exists events_anon_created_idx on public.events (anon_id, created_at);
create index if not exists events_name_created_idx on public.events (name, created_at);
create index if not exists events_game_uid_idx on public.events (game_uid);

alter table public.events
  -- So a typo or a spammer cannot invent event types. Phase 2's three names
  -- are here already, so shipping them needs no migration.
  add constraint events_name_known check (name in (
    'page_load', 'first_move', 'game_start', 'game_end', 'game_abandon',
    'tutorial_progress', 'share_open', 'share_copy'
  )),
  -- Plausibility bounds, so one bored person cannot fill the table with junk.
  add constraint events_props_sane check (length(props::text) <= 4096),
  -- A fixed range, since a check constraint cannot call now(). The point is
  -- only to reject a garbage clock, and created_at is what queries use anyway.
  add constraint events_client_ts_sane check (client_ts between '2020-01-01' and '2100-01-01');

alter table public.events enable row level security;

create policy events_anon_insert on public.events
  for insert to anon
  with check (true);

-- Column-level, for the reasons spelled out in `games.sql`: a bare
-- `grant insert` would hand the browser `id` and `created_at` as well.
revoke all on public.events from anon;
grant insert (event_uid, client_ts, anon_id, session_id, app_version, name, game_uid, props)
  on public.events to anon;
-- `usage` alone: the client never reads the sequence back.
grant usage on sequence public.events_id_seq to anon;
