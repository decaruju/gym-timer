-- Run this in the Supabase SQL editor for your project.
-- It creates one table per data type. Each row stores its payload as jsonb
-- so the schema does not need to change when the client adds fields.
-- Soft-delete via deleted_at lets deletions propagate across devices.

create table if not exists public.trainings (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.schedule (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.history (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists trainings_user_idx on public.trainings(user_id);
create index if not exists schedule_user_idx  on public.schedule(user_id);
create index if not exists history_user_idx   on public.history(user_id);

-- Row Level Security: every row is visible only to its owner.
alter table public.trainings enable row level security;
alter table public.schedule  enable row level security;
alter table public.history   enable row level security;
alter table public.settings  enable row level security;

-- One policy per table that gates SELECT/INSERT/UPDATE/DELETE on auth.uid().
do $$
declare t text;
begin
  foreach t in array array['trainings', 'schedule', 'history'] loop
    execute format($f$
      drop policy if exists "%1$s_owner_all" on public.%1$I;
      create policy "%1$s_owner_all" on public.%1$I
        for all
        using (auth.uid() = user_id)
        with check (auth.uid() = user_id);
    $f$, t);
  end loop;
end$$;

drop policy if exists "settings_owner_all" on public.settings;
create policy "settings_owner_all" on public.settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
