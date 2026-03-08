-- FitAI Pro schema
create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  user_id uuid unique generated always as (id) stored,
  display_name text,
  weight numeric,
  kpis jsonb default '{}'::jsonb,
  equipment jsonb default '{}'::jsonb,
  last_workout_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text,
  level text,
  text text,
  constraints text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id)
);

create table if not exists public.workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan jsonb not null,
  created_at timestamptz default now()
);

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  calories int default 0,
  protein int default 0,
  carbs int default 0,
  fat int default 0,
  date date not null default current_date,
  created_at timestamptz default now()
);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  kudos int default 0,
  created_at timestamptz default now()
);

create table if not exists public.body_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null,
  ai_feedback text,
  ai_version text,
  symmetry_score int,
  posture_score int,
  bodyfat_proxy int,
  created_at timestamptz default now()
);

create table if not exists public.nutrition_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  calories int not null,
  protein int not null,
  carbs int not null,
  fats int not null,
  notes text,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  title text not null,
  earned_at timestamptz default now(),
  unique(user_id, code)
);

create table if not exists public.training_schedule (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day_of_week int not null,
  workout_type text not null,
  intensity text,
  status text,
  notes text,
  week_start_date date not null,
  created_at timestamptz default now()
);

create index if not exists idx_goals_user_id on public.goals(user_id);
create index if not exists idx_sessions_user_id_created on public.workout_sessions(user_id, created_at desc);
create index if not exists idx_meals_user_date on public.meals(user_id, date);
create index if not exists idx_posts_created on public.community_posts(created_at desc);
create index if not exists idx_scans_user_created on public.body_scans(user_id, created_at desc);
create index if not exists idx_achievements_user on public.achievements(user_id);
create index if not exists idx_training_schedule_user_week on public.training_schedule(user_id, week_start_date);

alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.workout_sessions enable row level security;
alter table public.meals enable row level security;
alter table public.community_posts enable row level security;
alter table public.body_scans enable row level security;
alter table public.nutrition_targets enable row level security;
alter table public.achievements enable row level security;
alter table public.training_schedule enable row level security;

create policy "own rows" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "own goals" on public.goals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own sessions" on public.workout_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own meals" on public.meals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "read posts" on public.community_posts for select using (true);
create policy "write own posts" on public.community_posts for insert with check (auth.uid() = user_id);
create policy "update/delete own posts" on public.community_posts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own posts" on public.community_posts for delete using (auth.uid() = user_id);
create policy "own scans" on public.body_scans for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own nutrition" on public.nutrition_targets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own achievements" on public.achievements for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own schedule" on public.training_schedule for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public) values ('user_uploads','user_uploads', false)
on conflict (id) do nothing;

create policy "view own uploads" on storage.objects for select using (bucket_id = 'user_uploads' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "insert own uploads" on storage.objects for insert with check (bucket_id = 'user_uploads' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "update own uploads" on storage.objects for update using (bucket_id = 'user_uploads' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "delete own uploads" on storage.objects for delete using (bucket_id = 'user_uploads' and auth.uid()::text = (storage.foldername(name))[1]);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
