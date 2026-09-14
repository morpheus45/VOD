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

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Le compte ne doit JAMAIS pouvoir modifier sa propre restriction, sinon
--    elle se lève par un appel direct à l'API depuis la console du navigateur.
--
--    POURQUOI UN TRIGGER, ET PAS UNE POLITIQUE RLS.
--    public.profiles porte déjà la politique propriétaire « own profile »
--    (`create policy "own profile" on profiles for all using (auth.uid() = id)`,
--    voir le bloc SQL de référence en fin d'auth.js). Une version antérieure de
--    ce script tentait de supprimer une politique nommée « profiles_self_update »
--    — qui n'a jamais existé dans ce projet : le drop ne faisait rien, et la
--    politique créée ensuite s'ajoutait comme politique PERMISSIVE. Or PostgreSQL
--    combine les politiques permissives par OU : « own profile » continuait donc
--    d'autoriser le compte à écrire sa propre ligne, content_policy comprise.
--    Le verrou ne verrouillait rien.
--    Un trigger BEFORE UPDATE, lui, s'applique quelles que soient les politiques
--    RLS en place, ne casse pas « own profile », et n'exige aucune réécriture
--    des politiques existantes.
--
--    COMMENT ON RECONNAÎT UN ADMINISTRATEUR.
--    Le projet n'a qu'un seul test d'administration : profiles.plan = 'admin'.
--      • public.is_admin() — supabase/migrations/20260527000000_security_fixes.sql :
--        `select exists (select 1 from public.profiles
--                        where id = auth.uid() and plan = 'admin')` ;
--      • les politiques « admin all profiles / devices / payments / sessions »
--        du bloc SQL de référence d'auth.js, qui testent la même chose ;
--      • admin.html, qui force `plan:'admin'` en base avant toute opération
--        d'administration — « indispensable pour les politiques RLS » d'après
--        son propre commentaire.
--    On reprend ce test à l'identique, et rien d'autre : aucune nouvelle notion
--    d'administrateur n'est introduite ici. Il est recopié plutôt qu'appelé via
--    is_admin(), pour deux raisons : ce script doit pouvoir s'exécuter sur un
--    projet où la migration security_fixes n'a pas encore été passée, et
--    l'EXECUTE d'is_admin() n'est accordé qu'au rôle `authenticated`, alors que
--    le trigger s'exécute aussi sous d'autres rôles.
--
--    auth.uid() vaut NULL lorsque l'appel ne porte pas de JWT utilisateur
--    (éditeur SQL Supabase, clé service_role, migrations). Ces appels restent
--    autorisés : sans cela, plus personne ne pourrait poser une restriction.
--    C'est sans risque — la clé service_role n'est jamais servie au navigateur.

create or replace function public.freeze_content_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  appelant    uuid := auth.uid();
  plan_appelant text;
begin
  -- Rien à surveiller si la colonne n'est pas touchée.
  if new.content_policy is not distinct from old.content_policy then
    return new;
  end if;

  -- Appel sans JWT utilisateur : éditeur SQL / service_role.
  if appelant is null then
    return new;
  end if;

  select p.plan into plan_appelant from public.profiles p where p.id = appelant;
  if plan_appelant = 'admin' then
    return new;
  end if;

  -- Toute autre origine — le propriétaire de la ligne compris : on gèle la
  -- colonne. On ne lève PAS d'exception, pour que les mises à jour légitimes
  -- des autres colonnes (email, parental_pin, appareils…) continuent de
  -- passer ; seule content_policy est silencieusement remise à sa valeur.
  new.content_policy := old.content_policy;
  return new;
end;
$$;

drop trigger if exists trg_freeze_content_policy on public.profiles;
create trigger trg_freeze_content_policy
  before update on public.profiles
  for each row execute procedure public.freeze_content_policy();

-- La politique posée par la version antérieure de ce script ne protégeait rien
-- (voir ci-dessus). On la retire pour ne pas laisser croire le contraire.
drop policy if exists "profiles_self_update" on public.profiles;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Contrôle.
--    Une lecture ne prouve rien, et « update … set content_policy = 'all' » non
--    plus : si la valeur vaut DÉJÀ 'all', la requête réussit sans rien changer
--    et on conclut à tort que le verrou tient. Le seul contrôle valable TENTE
--    RÉELLEMENT DE CHANGER la valeur, en se faisant passer pour le compte
--    restreint, et compare l'avant et l'après.
--
--    Remplacer <UUID> par l'id du compte à tester (4 occurrences), décommenter,
--    puis exécuter le bloc d'un seul tenant. Le rollback final ne laisse aucune
--    trace, même si le verrou ne tient pas.
/*
begin;
  select 'avant' as etape, content_policy from public.profiles where id = '<UUID>';

  -- On devient ce compte, comme le ferait la console du navigateur.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<UUID>","role":"authenticated"}';

  -- Tentative de BASCULE : la valeur demandée est forcément différente de
  -- l'actuelle, donc un succès serait visible.
  update public.profiles
     set content_policy = case when content_policy = 'kids' then 'all' else 'kids' end
   where id = '<UUID>';

  reset role;
  select 'apres' as etape, content_policy from public.profiles where id = '<UUID>';
  -- ATTENDU : « avant » et « apres » affichent la MÊME valeur.
  -- Si elles diffèrent, le verrou ne tient pas : ne pas livrer.
rollback;
*/

--    CONTRÔLE INVERSE — le verrou ne doit pas bloquer l'administration.
--    Même bloc, mais en dissociant les deux identités : dans les claims, mettre
--    "sub" = l'UUID d'un compte dont profiles.plan = 'admin' ; dans les trois
--    `where id = …`, garder l'UUID du compte restreint. La valeur DOIT alors
--    changer entre « avant » et « apres ». Si elle ne change pas, c'est que le
--    trigger bloque aussi l'administrateur : admin.html ne pourrait plus poser
--    de restriction.

-- 5. Vue d'ensemble.
select email, plan, content_policy
from public.profiles
order by created_at desc
limit 10;
