-- Record of the Night Watch schema already applied to Supabase project
-- pnxsrycurozugxpiragc (London, free plan). Do not run this file against that
-- project again. It is stored so the database contract can be reproduced elsewhere.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.saved_walks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  route_mode text not null check (route_mode in ('fastest','balanced','safest')),
  route_geojson jsonb not null check (jsonb_typeof(route_geojson)='object' and pg_column_size(route_geojson) <= 100000),
  distance_m integer check (distance_m between 0 and 100000),
  duration_s integer check (duration_s between 0 and 86400),
  created_at timestamptz not null default now()
);
create index saved_walks_user_idx on public.saved_walks(user_id, created_at desc);
alter table public.saved_walks enable row level security;
revoke all on public.saved_walks from anon, authenticated;
grant select, delete on public.saved_walks to authenticated;
grant insert (name, route_mode, route_geojson, distance_m, duration_s) on public.saved_walks to authenticated;
grant update (name) on public.saved_walks to authenticated;
create policy "own walks select" on public.saved_walks for select to authenticated using ((select auth.uid()) = user_id);
create policy "own walks insert" on public.saved_walks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own walks update" on public.saved_walks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own walks delete" on public.saved_walks for delete to authenticated using ((select auth.uid()) = user_id);

create table public.community_reports (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('lighting','blocked-path','uncomfortable-experience')),
  lat numeric(8,5) not null check (lat between 51.28 and 51.70),
  lng numeric(8,5) not null check (lng between -0.52 and 0.34),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
create index community_reports_public_idx on public.community_reports(status, expires_at);

create table private.report_owners (
  report_id uuid primary key references public.community_reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index report_owners_user_idx on private.report_owners(user_id, created_at);
revoke all on private.report_owners from public, anon, authenticated;

create or replace function private.is_report_owner(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.report_owners o where o.report_id = rid and o.user_id = auth.uid());
$$;
revoke all on function private.is_report_owner(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_report_owner(uuid) to authenticated;

create or replace function private.prepare_report() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if (select count(*) from private.report_owners where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'report rate limit reached';
  end if;
  new.id := gen_random_uuid();
  new.status := 'pending';
  new.created_at := now();
  new.expires_at := now() + interval '48 hours';
  new.lat := round(new.lat, 3);
  new.lng := round(new.lng, 3);
  return new;
end $$;
create or replace function private.record_report_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.report_owners(report_id, user_id) values (new.id, auth.uid());
  return null;
end $$;
revoke all on function private.prepare_report() from public, anon, authenticated;
revoke all on function private.record_report_owner() from public, anon, authenticated;
create trigger community_reports_prepare before insert on public.community_reports for each row execute function private.prepare_report();
create trigger community_reports_owner after insert on public.community_reports for each row execute function private.record_report_owner();

alter table public.community_reports enable row level security;
revoke all on public.community_reports from anon, authenticated;
grant select on public.community_reports to anon, authenticated;
grant insert (category, lat, lng) on public.community_reports to authenticated;
create policy "public approved unexpired" on public.community_reports for select to anon, authenticated using (status = 'approved' and expires_at > now());
create policy "submitter sees own" on public.community_reports for select to authenticated using (private.is_report_owner(id));
create policy "authenticated submit" on public.community_reports for insert to authenticated with check ((select auth.uid()) is not null and status = 'pending');

alter publication supabase_realtime add table public.community_reports;
