-- Migration : table user_data pour synchroniser favoris + progression par compte
-- Déployer via : supabase db push  (ou coller dans l'éditeur SQL du dashboard Supabase)

create table if not exists user_data (
  user_id    uuid references auth.users on delete cascade primary key,
  progress   jsonb not null default '{}',
  favorites  jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- Row Level Security : chaque utilisateur ne voit et ne modifie QUE ses propres données
alter table user_data enable row level security;

create policy if not exists "user_data_own"
  on user_data for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
