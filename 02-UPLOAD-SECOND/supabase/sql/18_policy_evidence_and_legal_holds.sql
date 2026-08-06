begin;
create table if not exists public.policy_acceptance_evidence (
 id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), actor_type text not null check(actor_type in ('consumer','seller','admin','guest')), policy_code text not null, policy_version text not null, policy_hash text not null, accepted_at timestamptz not null default now(), ip_hash text, user_agent_hash text, order_id uuid, metadata jsonb not null default '{}'::jsonb
);
create table if not exists public.legal_holds (id uuid primary key default gen_random_uuid(), subject_type text not null, subject_id text not null, reason text not null, opened_by uuid references auth.users(id), opened_at timestamptz not null default now(), released_by uuid references auth.users(id), released_at timestamptz, status text not null default 'active' check(status in ('active','released')));
create table if not exists public.policy_publications (id uuid primary key default gen_random_uuid(), policy_code text not null, version text not null, content_hash text not null, effective_at timestamptz not null, published_at timestamptz not null default now(), published_by uuid references auth.users(id), content_url text not null, unique(policy_code,version));
alter table public.policy_acceptance_evidence enable row level security; alter table public.legal_holds enable row level security; alter table public.policy_publications enable row level security;
revoke all on public.policy_acceptance_evidence,public.legal_holds,public.policy_publications from anon,authenticated;
grant select on public.policy_publications to anon,authenticated;
create policy policy_publications_public_read on public.policy_publications for select using(effective_at<=now());
insert into public.policy_publications(policy_code,version,content_hash,effective_at,content_url) values
('BUYER_TERMS','2026.08.06-v1','REPLACE_WITH_BUILD_HASH','2026-08-06T00:00:00+09:00','/policies/terms.html'),
('PRIVACY_POLICY','2026.08.06-v1','REPLACE_WITH_BUILD_HASH','2026-08-06T00:00:00+09:00','/policies/privacy.html'),
('COMMERCE_POLICY','2026.08.06-v1','REPLACE_WITH_BUILD_HASH','2026-08-06T00:00:00+09:00','/policies/commerce.html'),
('SELLER_TERMS','2026.08.06-v1','REPLACE_WITH_BUILD_HASH','2026-08-06T00:00:00+09:00','/policies/seller.html') on conflict do nothing;
commit;
