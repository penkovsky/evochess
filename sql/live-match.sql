-- Live match over a link (docs/live-match.md).
--
-- The backend knows no chess: it stores moves, decides whose turn it is by ply
-- parity, and hands out seat tokens. Both clients run the engine.
--
-- The anon key gets EXECUTE on the four functions below and nothing else. No
-- SELECT, INSERT, UPDATE or DELETE on either table. The insert-only,
-- read-nothing posture of `events`/`games` is unchanged.

create extension if not exists pgcrypto;

create table if not exists public.lm_matches (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  start_payload text check (length(start_payload) <= 2048), -- ?p=, null at the opening
  first_mover   char(1) not null check (first_mover in ('w', 'b')),
  -- Null is the free seat. Exactly one of the two is null at 'waiting'.
  white_token   text,
  black_token   text,
  creator_seat  char(1) not null check (creator_seat in ('w', 'b')),
  status        text not null default 'waiting' check (status in ('waiting', 'live', 'over'))
);

create table if not exists public.lm_moves (
  match_id uuid not null references public.lm_matches(id) on delete cascade,
  ply      int  not null check (ply between 1 and 1000),
  from_sq  text not null check (from_sq ~ '^[a-h][1-8]$'),
  to_sq    text not null check (to_sq   ~ '^[a-h][1-8]$'),
  -- ApplyMoveOptions as JSON. The client allowlists the keys on receipt, so an
  -- unexpected one never reaches the engine; this only bounds the size.
  opts     jsonb not null default '{}'::jsonb
                 check (pg_column_size(opts) <= 256),
  -- How stale a match is: max(created_at) per match is its last move. Retention
  -- and abandonment both need that; nothing else advances after creation.
  -- lm_fetch never returns it.
  created_at timestamptz not null default now(),
  primary key (match_id, ply)
);

alter table public.lm_moves
  add column if not exists created_at timestamptz not null default now();

-- The rematch ask, one flag per seat (docs/live-match.md §Milestone 2b). Both
-- set creates the next match, whose id is written back here so each side
-- follows it.
alter table public.lm_matches
  add column if not exists white_rematch boolean not null default false,
  add column if not exists black_rematch boolean not null default false,
  add column if not exists rematch_id uuid references public.lm_matches(id);

-- No policies and no grants: RLS on with nothing granted is the lockout.
alter table public.lm_matches enable row level security;
alter table public.lm_moves   enable row level security;

-- gen_random_bytes, not random(), which is seeded and predictable. The token is
-- all that stands between a reader and a seat.
--
-- `extensions` is in the search_path because that is where Supabase installs
-- pgcrypto. Elsewhere it lands in public, and a schema that does not exist is
-- ignored, so this works both ways.
create or replace function public.lm_token() returns text
language sql volatile set search_path = public, extensions, pg_temp as $$
  select translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

create or replace function public.lm_other(c char(1)) returns char(1)
language sql immutable as $$ select case when c = 'w' then 'b' else 'w' end $$;

-- Creator's own seat and token. The other seat stays null until lm_join.
create or replace function public.lm_create(
  p_start_payload text,
  p_first_mover   char(1),
  p_creator_seat  char(1)
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text := lm_token(); id uuid;
begin
  if p_first_mover not in ('w', 'b') or p_creator_seat not in ('w', 'b') then
    raise exception 'bad seat' using errcode = 'P0001';
  end if;
  insert into lm_matches (start_payload, first_mover, creator_seat, white_token, black_token)
  values (p_start_payload, p_first_mover, p_creator_seat,
          case when p_creator_seat = 'w' then tok end,
          case when p_creator_seat = 'b' then tok end)
  returning lm_matches.id into id;
  return jsonb_build_object('match_id', id, 'token', tok);
end $$;

-- The conditional update is the entire race resolution: zero rows means the
-- seat went to someone else.
create or replace function public.lm_join(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text := lm_token(); seat char(1); n int;
begin
  select lm_other(creator_seat) into seat from lm_matches where id = p_match;
  if seat is null then raise exception 'unknown match' using errcode = 'P0002'; end if;
  if seat = 'w' then
    update lm_matches set white_token = tok, status = 'live'
      where id = p_match and white_token is null and status = 'waiting';
  else
    update lm_matches set black_token = tok, status = 'live'
      where id = p_match and black_token is null and status = 'waiting';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'seat taken' using errcode = 'P0001'; end if;
  return jsonb_build_object('seat', seat, 'token', tok);
end $$;

-- Turn ownership is ply parity against first_mover, and the ply is pinned to
-- one past the highest stored. Both live here, not in the client.
create or replace function public.lm_play(
  p_match uuid, p_token text, p_ply int,
  p_from text, p_to text, p_opts jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m lm_matches; seat char(1); tok text; last int;
begin
  select * into m from lm_matches where id = p_match;
  if not found then raise exception 'unknown match' using errcode = 'P0002'; end if;
  if m.status <> 'live' then raise exception 'match not live' using errcode = 'P0001'; end if;
  seat := case when p_ply % 2 = 1 then m.first_mover else lm_other(m.first_mover) end;
  tok  := case when seat = 'w' then m.white_token else m.black_token end;
  if tok is null or tok <> p_token then raise exception 'not your seat' using errcode = 'P0001'; end if;
  select coalesce(max(ply), 0) into last from lm_moves where match_id = p_match;
  if p_ply <= last then
    -- A retried send. Idempotent when it is the same move, and a conflict only
    -- when it is not.
    if exists (select 1 from lm_moves
                where match_id = p_match and ply = p_ply and from_sq = p_from and to_sq = p_to)
    then return; end if;
    raise exception 'ply conflict' using errcode = '23505';
  end if;
  if p_ply <> last + 1 then raise exception 'ply gap' using errcode = 'P0001'; end if;
  insert into lm_moves (match_id, ply, from_sq, to_sq, opts)
  values (p_match, p_ply, p_from, p_to, coalesce(p_opts, '{}'::jsonb));
end $$;

-- The rematch ask. Sets the caller's flag, and once both are set creates the
-- next match and hands the caller its seat in it. The seats swap colour.
--
-- Idempotent: a client calls this to ask, and calls it again once a poll shows
-- the next match exists, to collect a token lm_fetch will not give it. The row
-- is locked because both sides may arrive at once, and only one next match may
-- be created.
create or replace function public.lm_rematch(p_match uuid, p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m lm_matches; seat char(1); next_seat char(1); nxt_id uuid; tok text;
begin
  select * into m from lm_matches where id = p_match for update;
  if not found then raise exception 'unknown match' using errcode = 'P0002'; end if;
  seat := case when m.white_token = p_token then 'w'
               when m.black_token = p_token then 'b' end;
  if seat is null then raise exception 'not your seat' using errcode = 'P0001'; end if;
  -- The seats swap, so the caller's next seat is the other one.
  next_seat := lm_other(seat);
  if seat = 'w' then
    update lm_matches set white_rematch = true where id = p_match returning * into m;
  else
    update lm_matches set black_rematch = true where id = p_match returning * into m;
  end if;
  nxt_id := m.rematch_id;
  if nxt_id is null and m.white_rematch and m.black_rematch then
    insert into lm_matches (start_payload, first_mover, creator_seat, white_token, black_token, status)
    values (m.start_payload, m.first_mover, next_seat, lm_token(), lm_token(), 'live')
    returning id into nxt_id;
    -- Nothing more can be appended to a game both players have left.
    update lm_matches set rematch_id = nxt_id, status = 'over' where id = p_match;
  end if;
  if nxt_id is null then return jsonb_build_object('asked', true); end if;
  select case when next_seat = 'w' then white_token else black_token end
    into tok from lm_matches where id = nxt_id;
  return jsonb_build_object(
    'asked', true,
    'match_id', nxt_id,
    'seat', next_seat,
    'token', tok,
    'first_mover', m.first_mover,
    'start_payload', m.start_payload);
end $$;

-- The only read path. Never returns a token; an unknown id returns null.
create or replace function public.lm_fetch(p_match uuid, p_since int) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'status', m.status,
    'first_mover', m.first_mover,
    'start_payload', m.start_payload,
    'joined', (m.white_token is not null and m.black_token is not null),
    -- Which seat is still free, so the client can label the join button. Not a
    -- token, and it says nothing the `joined` flag does not already imply.
    'free_seat', case when m.white_token is null then 'w'
                      when m.black_token is null then 'b' end,
    -- Who has asked for a rematch, and the match it turned into. An id, not a
    -- token: it reads the next match, exactly as the link to this one does.
    'rematch_w', m.white_rematch,
    'rematch_b', m.black_rematch,
    'rematch_id', m.rematch_id,
    'moves', coalesce((
      select jsonb_agg(jsonb_build_object('ply', x.ply, 'from', x.from_sq, 'to', x.to_sq, 'opts', x.opts)
                       order by x.ply)
        from lm_moves x
       where x.match_id = m.id and x.ply > coalesce(p_since, 0)
    ), '[]'::jsonb))
  from lm_matches m where m.id = p_match;
$$;

revoke all on function public.lm_token()             from public;
revoke all on function public.lm_other(char)         from public;
revoke all on function public.lm_create(text, char, char) from public;
revoke all on function public.lm_join(uuid)          from public;
revoke all on function public.lm_play(uuid, text, int, text, text, jsonb) from public;
revoke all on function public.lm_fetch(uuid, int)    from public;
revoke all on function public.lm_rematch(uuid, text) from public;

grant execute on function public.lm_create(text, char, char) to anon;
grant execute on function public.lm_join(uuid)               to anon;
grant execute on function public.lm_play(uuid, text, int, text, text, jsonb) to anon;
grant execute on function public.lm_fetch(uuid, int)         to anon;
grant execute on function public.lm_rematch(uuid, text)      to anon;
