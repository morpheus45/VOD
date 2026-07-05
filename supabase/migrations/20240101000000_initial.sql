-- PIPSILY — Schéma initial Supabase

-- ① Profils utilisateurs
create table if not exists profiles (
  id                      uuid references auth.users primary key,
  email                   text,
  plan                    text default 'pending',
  subscription_expires_at timestamptz,
  devices_allowed         integer default 1,
  parental_pin            text,
  created_at              timestamptz default now()
);

-- ② Appareils
create table if not exists devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  device_id   text,
  device_name text,
  monthly_fee numeric default 0,
  last_seen   timestamptz default now(),
  created_at  timestamptz default now(),
  unique(user_id, device_id)
);

-- ③ Sessions (1 connexion simultanée)
create table if not exists sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade,
  device_id  text,
  token      text,
  created_at timestamptz default now()
);

-- ④ Paiements (suivi manuel)
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references profiles(id) on delete cascade,
  amount       numeric,
  type         text default 'subscription',
  period_start date,
  period_end   date,
  confirmed_at timestamptz,
  confirmed_by uuid,
  notes        text,
  created_at   timestamptz default now()
);

-- ⑤ Trigger auto-création profil
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, plan)
  values (new.id, new.email,
    case when new.email = 'cedric.lago@gmail.com' then 'admin' else 'pending' end);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ⑥ RLS
alter table profiles enable row level security;
alter table devices  enable row level security;
alter table sessions enable row level security;
alter table payments enable row level security;

-- Test admin SANS récursion RLS : security definer contourne la RLS de profiles.
create or replace function is_admin()
returns boolean language sql security definer stable
set search_path = public as $$
  select exists(
    select 1 from profiles where id = auth.uid() and plan = 'admin'
  );
$$;

-- Empêche un abonné de s'auto-promouvoir : bloque toute modification des
-- colonnes sensibles (plan / quota d'appareils / expiration) par un non-admin,
-- tout en laissant l'admin les modifier depuis le panneau.
create or replace function protect_profile_columns()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if is_admin() then
    return new;
  end if;
  if new.plan is distinct from old.plan
     or new.devices_allowed is distinct from old.devices_allowed
     or new.subscription_expires_at is distinct from old.subscription_expires_at then
    raise exception 'Modification de colonnes protégées non autorisée';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_profile on profiles;
create trigger trg_protect_profile
  before update on profiles
  for each row execute function protect_profile_columns();

drop policy if exists "own profile"          on profiles;
drop policy if exists "admin all profiles"   on profiles;
drop policy if exists "profile select"       on profiles;
drop policy if exists "profile insert"       on profiles;
drop policy if exists "profile update"       on profiles;
drop policy if exists "own devices"          on devices;
drop policy if exists "own sessions"         on sessions;
drop policy if exists "own payments"         on payments;
drop policy if exists "payments select"      on payments;
drop policy if exists "admin all devices"    on devices;
drop policy if exists "admin all payments"   on payments;
drop policy if exists "admin all sessions"   on sessions;

-- profiles : lecture de sa propre ligne (ou toutes pour l'admin) ; l'utilisateur
-- ne peut créer/mettre à jour QUE sa propre ligne (WITH CHECK), et le trigger
-- ci-dessus verrouille les colonnes sensibles.
create policy "profile select" on profiles for select
  using (auth.uid() = id or is_admin());
create policy "profile insert" on profiles for insert
  with check (auth.uid() = id or is_admin());
create policy "profile update" on profiles for update
  using (auth.uid() = id or is_admin())
  with check (auth.uid() = id or is_admin());

-- devices / sessions : l'utilisateur gère les siens (avec WITH CHECK) ; admin voit tout.
create policy "own devices"  on devices  for all
  using (auth.uid() = user_id or is_admin())
  with check (auth.uid() = user_id or is_admin());
create policy "own sessions" on sessions for all
  using (auth.uid() = user_id or is_admin())
  with check (auth.uid() = user_id or is_admin());

-- payments : LECTURE SEULE pour l'abonné (pas d'insertion de faux paiements) ;
-- seul l'admin peut écrire.
create policy "payments select" on payments for select
  using (auth.uid() = user_id or is_admin());
create policy "admin all payments" on payments for all
  using (is_admin())
  with check (is_admin());
