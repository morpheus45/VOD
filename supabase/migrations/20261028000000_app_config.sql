-- PIPSILY — réglages globaux modifiables depuis l'admin (identifiants Xtream).
-- Lecture ouverte : ces identifiants figurent déjà dans les URL des catalogues
-- publics. Écriture réservée à l'admin (is_admin(), migration 20260527).
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

drop policy if exists "app_config_read" on public.app_config;
create policy "app_config_read" on public.app_config for select using (true);

drop policy if exists "app_config_admin" on public.app_config;
create policy "app_config_admin" on public.app_config for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.app_config to anon, authenticated;
grant insert, update, delete on public.app_config to authenticated;
