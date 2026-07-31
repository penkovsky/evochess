-- The browser holds the anon key and may only INSERT. No select, no update, no
-- delete: analysis runs from the SQL editor under the service role.

create table if not exists public.games (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  game_uid     uuid not null unique,   -- client-minted, so a retry cannot double-insert
  anon_id      uuid not null,          -- per-browser, from localStorage
  app_version  text not null,          -- git sha
  mode         text not null,
  level        text,                   -- null when mode is human-human
  ai_color     text not null,
  from_shared  boolean not null,
  start_fen    text not null,          -- not always the opening: a shared link starts anywhere
  start_param  text,                   -- the ?p= payload when there was one; a FEN cannot carry
                                       -- rights, counters or charges, so this is what a shared
                                       -- game's log actually replays from. null when it began
                                       -- from the opening.
  moves        text not null,          -- moveLog joined with ' '
  moves_tokens text,                    -- moveTokens joined with ' '; null for rows written before this
  outcome      text not null,          -- from the human's side; from White's side in human-human
  plies        int not null,
  duration_ms  int not null            -- first move to last
);

alter table public.games
  add constraint games_mode_known check (mode in ('human-ai', 'human-human')),
  add constraint games_level_known check (level is null or level in ('easy', 'zen', 'fun')),
  add constraint games_ai_color_known check (ai_color in ('w', 'b')),
  add constraint games_outcome_known check (outcome in ('win', 'loss', 'draw', 'timeout')),
  -- Plausibility bounds, so one bored person cannot fill the table with junk.
  add constraint games_plies_sane check (plies between 0 and 2000),
  add constraint games_duration_sane check (duration_ms between 0 and 86400000),
  add constraint games_moves_sane check (length(moves) <= 32768),
  add constraint games_tokens_sane check (moves_tokens is null or length(moves_tokens) <= 32768),
  add constraint games_start_fen_sane check (length(start_fen) between 10 and 120),
  -- The decoder's own ceiling on a share payload.
  add constraint games_start_param_sane check (start_param is null or length(start_param) <= 4096);

alter table public.games enable row level security;

create policy games_anon_insert on public.games
  for insert to anon
  with check (true);

-- Column-level, not a bare `grant insert`: that would let the browser write
-- `id` and `created_at` too. Forging `created_at` defeats the reason the client
-- clock is a separate column, and writing an `id` directly does not advance the
-- sequence, so the counter eventually reaches a taken number and every real
-- insert starts failing. Neither column is on this list, so the defaults stand.
revoke all on public.games from anon;
grant insert (game_uid, anon_id, app_version, mode, level, ai_color, from_shared,
              start_fen, start_param, moves, moves_tokens, outcome, plies, duration_ms)
  on public.games to anon;
-- `usage` alone: the client never reads the sequence back.
grant usage on sequence public.games_id_seq to anon;
