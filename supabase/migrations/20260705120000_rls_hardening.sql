-- PIPSILY — Durcissement RLS (audit 2026-07-05)
-- Idempotent : peut être ré-exécuté sans danger.
-- Corrige : auto-promotion d'abonné (plan/devices_allowed), récursion RLS admin,
-- insertion de faux paiements. Voir AUDIT_TV_2026-07-05.md (finding S2).

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

-- Purge DÉTERMINISTE : supprime toutes les policies existantes sur ces tables,
-- quels que soient leurs noms (les bases déployées avaient des noms non standard
-- comme "own"/"admin_profiles" que des DROP nommés ne matchaient pas).
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('profiles','payments','devices','sessions')
  loop
    execute format('drop policy if exists %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles : lecture de sa propre ligne (ou toutes pour l'admin) ; création/MAJ
-- de SA propre ligne uniquement (WITH CHECK), colonnes sensibles verrouillées
-- par le trigger ci-dessus.
create policy "profile select" on profiles for select
  using (auth.uid() = id or is_admin());
create policy "profile insert" on profiles for insert
  with check (auth.uid() = id or is_admin());
create policy "profile update" on profiles for update
  using (auth.uid() = id or is_admin())
  with check (auth.uid() = id or is_admin());

-- devices / sessions : l'utilisateur gère les siens (WITH CHECK) ; admin voit tout.
create policy "own devices"  on devices  for all
  using (auth.uid() = user_id or is_admin())
  with check (auth.uid() = user_id or is_admin());
create policy "own sessions" on sessions for all
  using (auth.uid() = user_id or is_admin())
  with check (auth.uid() = user_id or is_admin());

-- payments : LECTURE SEULE pour l'abonné (pas de faux paiements) ; écriture admin.
create policy "payments select" on payments for select
  using (auth.uid() = user_id or is_admin());
create policy "admin all payments" on payments for all
  using (is_admin())
  with check (is_admin());
