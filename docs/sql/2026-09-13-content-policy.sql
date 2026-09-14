-- Restriction de contenu par compte.
-- Voir docs/superpowers/specs/2026-09-13-restriction-contenu-par-compte-design.md
-- À exécuter une fois dans l'éditeur SQL du projet Supabase.
--
-- CORRIGÉ le 2026-09-14 après revue. La première version supprimait une
-- politique nommée "profiles_self_update" qui N'EXISTE PAS dans ce schéma : la
-- politique propriétaire s'appelle "own profile" (voir le bloc SQL de
-- référence en fin de auth.js). Le drop était donc sans effet, et la nouvelle
-- politique s'ajoutait comme PERMISSIVE. PostgreSQL faisant un OU entre
-- politiques permissives, "own profile" continuait d'autoriser le compte à
-- modifier sa propre ligne : l'enfant pouvait lever sa restriction par un
-- appel direct à l'API. On passe donc par un déclencheur, qui s'applique quoi
-- qu'il arrive, sans dépendre du nom ni du nombre des politiques existantes.

-- 1. La colonne. 'all' = aucune restriction, 'kids' = jeunesse uniquement.
alter table public.profiles
  add column if not exists content_policy text not null default 'all';

-- 2. Valeurs autorisées, pour qu'une faute de frappe ne passe pas en base.
alter table public.profiles
  drop constraint if exists profiles_content_policy_check;
alter table public.profiles
  add constraint profiles_content_policy_check
  check (content_policy in ('all', 'kids'));

-- 3. Gel de la colonne pour tout le monde sauf les administrateurs.
--    security definer : le déclencheur doit pouvoir lire la ligne de l'appelant
--    pour vérifier son plan, sans être lui-même soumis aux politiques RLS.
create or replace function public.freeze_content_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  appelant_admin boolean;
begin
  -- Rien à contrôler si la colonne ne change pas.
  if new.content_policy is not distinct from old.content_policy then
    return new;
  end if;

  -- auth.uid() est nul pour le rôle de service et dans l'éditeur SQL :
  -- le propriétaire garde la main en direct sur sa propre base.
  if auth.uid() is null then
    return new;
  end if;

  -- Double contrôle, comme le fait l'application : par le plan ET par l'email.
  -- admin.html force plan='admin' au chargement, mais si cette ligne était
  -- remise à 'pending' pour une raison quelconque, le panneau d'administration
  -- se retrouverait bloqué sur cette colonne. L'email sert de filet.
  select (p.plan = 'admin' or lower(p.email) = 'cedric.lago@gmail.com')
    into appelant_admin
  from public.profiles p
  where p.id = auth.uid();

  if coalesce(appelant_admin, false) then
    return new;
  end if;

  raise exception
    'content_policy ne peut etre modifie que par un administrateur';
end;
$$;

drop trigger if exists trg_freeze_content_policy on public.profiles;
create trigger trg_freeze_content_policy
  before update on public.profiles
  for each row
  execute function public.freeze_content_policy();

-- 4. Contrôle. Attendu : la colonne existe et vaut 'all' partout.
select email, plan, content_policy
from public.profiles
order by created_at desc
limit 10;
