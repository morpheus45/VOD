-- Restriction de contenu par compte.
-- Voir docs/superpowers/specs/2026-09-13-restriction-contenu-par-compte-design.md
-- À exécuter une fois dans l'éditeur SQL du projet Supabase.

-- 1. La colonne. 'all' = aucune restriction, 'kids' = jeunesse uniquement.
alter table public.profiles
  add column if not exists content_policy text not null default 'all';

-- 2. Valeurs autorisées, pour qu'une faute de frappe ne passe pas en base.
alter table public.profiles
  drop constraint if exists profiles_content_policy_check;
alter table public.profiles
  add constraint profiles_content_policy_check
  check (content_policy in ('all', 'kids'));

-- 3. Le compte ne doit JAMAIS pouvoir modifier sa propre restriction, sinon
--    elle se lève par un appel direct à l'API. On remplace la politique de
--    mise à jour par une version qui gèle la colonne pour le propriétaire.
--    Les administrateurs passent par une autre politique (« admin all
--    profiles ») et ne sont donc pas concernés par ce verrou.
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update"
  on public.profiles for update
  using  (auth.uid() = id)
  with check (
    auth.uid() = id
    and content_policy = (select p.content_policy from public.profiles p where p.id = auth.uid())
  );

-- 4. Contrôle : la colonne existe et vaut 'all' partout.
select email, plan, content_policy
from public.profiles
order by created_at desc
limit 10;
