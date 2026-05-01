-- ESMET Fixture Mundial — Supabase schema
-- Ejecutar en SQL Editor de Supabase. Idempotente: se puede correr varias veces.

-- ─────────────────────────────────────────────
-- 1. Tablas
-- ─────────────────────────────────────────────

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create table if not exists teams (
  id int primary key,                  -- id de api-football
  name text not null,                  -- "Argentina"
  code text,                           -- "ARG"
  flag_url text,
  group_letter text                    -- "A".."L" en grupos, null en knockout
);

create table if not exists matches (
  id int primary key,                  -- fixture id de api-football
  stage text not null,                 -- "Group Stage" | "Round of 32" | "Round of 16" | ...
  group_letter text,
  round_label text,                    -- "Jornada 1" o "Octavos"
  kickoff_at timestamptz not null,
  home_team_id int references teams(id),
  away_team_id int references teams(id),
  home_score int,
  away_score int,
  status text not null default 'scheduled',  -- scheduled | live | finished | postponed
  updated_at timestamptz not null default now()
);

create index if not exists matches_kickoff_idx on matches(kickoff_at);
create index if not exists matches_status_idx on matches(status);

create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  match_id int not null references matches(id) on delete cascade,
  home_score int not null check (home_score >= 0 and home_score <= 30),
  away_score int not null check (away_score >= 0 and away_score <= 30),
  points_awarded int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, match_id)
);

create index if not exists predictions_user_idx on predictions(user_id);
create index if not exists predictions_match_idx on predictions(match_id);

create table if not exists bonus_predictions (
  user_id uuid primary key references profiles(id) on delete cascade,
  champion_team_id int references teams(id),
  runner_up_team_id int references teams(id),
  points_awarded int,
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 2. Vista del leaderboard
-- ─────────────────────────────────────────────

create or replace view leaderboard as
select
  p.id as user_id,
  p.name,
  coalesce(sum(pr.points_awarded), 0) + coalesce(bp.points_awarded, 0) as total_points,
  count(pr.id) filter (where pr.points_awarded is not null) as graded_count,
  count(pr.id) filter (where pr.points_awarded = 3) as exact_count
from profiles p
left join predictions pr on pr.user_id = p.id
left join bonus_predictions bp on bp.user_id = p.id
group by p.id, p.name, bp.points_awarded;

-- ─────────────────────────────────────────────
-- 3. RLS — Row Level Security
-- ─────────────────────────────────────────────

alter table profiles enable row level security;
alter table teams enable row level security;
alter table matches enable row level security;
alter table predictions enable row level security;
alter table bonus_predictions enable row level security;

-- Profiles: cualquiera autenticado lee (para leaderboard); solo el dueño edita su propio perfil.
drop policy if exists "profiles_select_all" on profiles;
create policy "profiles_select_all" on profiles
  for select using (auth.role() = 'authenticated');

drop policy if exists "profiles_insert_self" on profiles;
create policy "profiles_insert_self" on profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_self" on profiles;
create policy "profiles_update_self" on profiles
  for update using (auth.uid() = id);

-- Teams + matches: solo lectura para autenticados. Escritura solo desde service_role (edge function).
drop policy if exists "teams_select_all" on teams;
create policy "teams_select_all" on teams
  for select using (auth.role() = 'authenticated');

drop policy if exists "matches_select_all" on matches;
create policy "matches_select_all" on matches
  for select using (auth.role() = 'authenticated');

-- Predictions: cualquiera ve picks de cualquiera (transparencia tipo fixture).
-- Solo el dueño escribe, y solo si el partido NO empezó.
drop policy if exists "predictions_select_all" on predictions;
create policy "predictions_select_all" on predictions
  for select using (auth.role() = 'authenticated');

drop policy if exists "predictions_insert_own_before_kickoff" on predictions;
create policy "predictions_insert_own_before_kickoff" on predictions
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from matches m
      where m.id = match_id and m.kickoff_at > now()
    )
  );

drop policy if exists "predictions_update_own_before_kickoff" on predictions;
create policy "predictions_update_own_before_kickoff" on predictions
  for update using (
    auth.uid() = user_id
    and exists (
      select 1 from matches m
      where m.id = match_id and m.kickoff_at > now()
    )
  );

-- Bonus: cierre cuando arranca el primer partido del Mundial.
drop policy if exists "bonus_select_all" on bonus_predictions;
create policy "bonus_select_all" on bonus_predictions
  for select using (auth.role() = 'authenticated');

drop policy if exists "bonus_upsert_own_before_start" on bonus_predictions;
create policy "bonus_upsert_own_before_start" on bonus_predictions
  for insert with check (
    auth.uid() = user_id
    and (select min(kickoff_at) from matches) > now()
  );

drop policy if exists "bonus_update_own_before_start" on bonus_predictions;
create policy "bonus_update_own_before_start" on bonus_predictions
  for update using (
    auth.uid() = user_id
    and (select min(kickoff_at) from matches) > now()
  );

-- ─────────────────────────────────────────────
-- 4. Trigger: crear profile al registrarse en auth
-- ─────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- 5. Trigger: updated_at
-- ─────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists predictions_touch on predictions;
create trigger predictions_touch
  before update on predictions
  for each row execute function public.touch_updated_at();

drop trigger if exists matches_touch on matches;
create trigger matches_touch
  before update on matches
  for each row execute function public.touch_updated_at();
