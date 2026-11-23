-- Media Sosial Sender — database schema
-- All tables are only reachable through the Edge Function (service role).
-- RLS is enabled with no policies, so the public anon key cannot read them.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.app_state (
  id text primary key,
  json jsonb not null,
  updated_at bigint not null
);

create table if not exists public.connections (
  profile_id text not null,
  platform text not null check (platform in ('yt', 'fb', 'ig', 'threads')),
  status text not null,                 -- connected | select
  account_id text,
  account_name text,
  token_enc text,
  refresh_enc text,
  expires_at bigint,
  extra_enc text,
  updated_at bigint not null,
  primary key (profile_id, platform)
);

create table if not exists public.posts (
  id text primary key,
  profile_id text not null,
  profile_name text,
  title text,
  caption text,
  aspect text,
  quality text,
  media_key text not null,
  media_name text,
  media_size bigint,
  media_type text,
  thumb_key text,
  media_deleted boolean not null default false,
  created_at bigint not null
);

create table if not exists public.jobs (
  id text primary key,
  post_id text not null references public.posts (id) on delete cascade,
  profile_id text not null,
  platform text not null,
  run_at bigint not null,
  status text not null,                 -- pending | processing | waiting | published | failed | cancelled
  container_id text,
  next_check_at bigint,
  attempts integer not null default 0,
  result_id text,
  result_url text,
  error text,
  updated_at bigint not null
);

create index if not exists jobs_due on public.jobs (status, run_at);
create index if not exists jobs_post on public.jobs (post_id);

alter table public.app_state enable row level security;
alter table public.connections enable row level security;
alter table public.posts enable row level security;
alter table public.jobs enable row level security;

-- Private bucket for videos & thumbnails (uploaded via signed URLs, deleted after posting)
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;
