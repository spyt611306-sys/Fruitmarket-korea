-- 푸릇마켓 Part 45: 소비자·판매자·관리자·인증·결제·배송·정산 전체 기능 확장
-- 01~08 실행 후 이 파일을 실행합니다.

create extension if not exists pgcrypto;

-- 회원/인증 보완
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists grade text not null default 'NORMAL';
alter table public.profiles add column if not exists marketing_opt_in boolean not null default false;
alter table public.profiles add column if not exists last_login_at timestamptz;
alter table public.profiles add column if not exists withdrawal_requested_at timestamptz;
alter table public.profiles add column if not exists suspended_reason text;
alter table public.profiles add column if not exists terms_version text;
alter table public.profiles add column if not exists privacy_version text;
alter table public.profiles add column if not exists age_confirmed_at timestamptz;
alter table public.reviews add column if not exists image_urls jsonb not null default '[]'::jsonb;

create table if not exists public.consent_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  email text,
  scope text not null,
  policy_code text not null,
  policy_version text not null,
  content_hash text not null,
  consented boolean not null,
  ip_hash text,
  user_agent_hash text,
  client_submission_id text,
  consented_at timestamptz not null default now(),
  unique(user_id, policy_code, policy_version, client_submission_id)
);

create table if not exists public.auth_security_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  success boolean not null default true,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists auth_security_events_user_idx on public.auth_security_events(user_id, created_at desc);

-- 판매자 입점 확장
alter table public.seller_applications add column if not exists business_start_date date;
alter table public.seller_applications add column if not exists representative_name text;
alter table public.seller_applications add column if not exists business_type text;
alter table public.seller_applications add column if not exists business_item text;
alter table public.seller_applications add column if not exists postal_code text;
alter table public.seller_applications add column if not exists road_address text;
alter table public.seller_applications add column if not exists detail_address text;
alter table public.seller_applications add column if not exists business_document_path text;
alter table public.seller_applications add column if not exists business_verification_status text not null default 'PENDING';
alter table public.seller_applications add column if not exists business_verification_payload jsonb not null default '{}'::jsonb;
alter table public.seller_applications add column if not exists identity_verification_id uuid;
alter table public.seller_applications add column if not exists agreement_receipts jsonb not null default '[]'::jsonb;
alter table public.seller_applications add column if not exists updated_at timestamptz not null default now();

create table if not exists public.identity_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  purpose text not null,
  provider text not null default 'PASS',
  status text not null default 'STARTED' check (status in ('STARTED','VERIFIED','FAILED','EXPIRED')),
  provider_session_id text,
  verified_name text,
  verified_phone text,
  birth_year smallint,
  requested_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.seller_kyc (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null unique references public.sellers(id) on delete cascade,
  provider text not null default 'TOSS_PAYOUT',
  provider_seller_id text,
  status text not null default 'NOT_STARTED' check (status in ('NOT_STARTED','APPROVAL_REQUIRED','PARTIALLY_APPROVED','KYC_REQUIRED','APPROVED','REJECTED','SUSPENDED')),
  expires_at timestamptz,
  last_checked_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 상품/재고 확장
alter table public.products add column if not exists weight_spec text;
alter table public.products add column if not exists min_order_quantity integer not null default 1;
alter table public.products add column if not exists max_order_quantity integer not null default 99;
alter table public.products add column if not exists shipping_fee bigint not null default 3000;
alter table public.products add column if not exists shipping_policy jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists return_policy jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists product_notice jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists reward_rate numeric(5,2) not null default 0;
alter table public.products add column if not exists reward_max bigint not null default 0;
alter table public.products add column if not exists approval_reason text;
alter table public.product_options add column if not exists reserved_stock integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='product_options_reserved_guard' and conrelid='public.product_options'::regclass) then
    alter table public.product_options add constraint product_options_reserved_guard check (reserved_stock >= 0 and reserved_stock <= stock_quantity) not valid;
  end if;
end $$;

create table if not exists public.product_approval_history (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status text not null,
  reason text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id bigint generated always as identity primary key,
  seller_id uuid not null references public.sellers(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  option_id uuid references public.product_options(id) on delete restrict,
  movement_type text not null,
  quantity integer not null,
  reference_type text,
  reference_id text,
  before_quantity integer,
  after_quantity integer,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_movements_product_idx on public.inventory_movements(product_id, created_at desc);

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  option_id uuid references public.product_options(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'RESERVED' check (status in ('RESERVED','COMMITTED','RELEASED','EXPIRED')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inventory_reservations_expiry_idx on public.inventory_reservations(status, expires_at);

create table if not exists public.inventory_excel_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  version text not null,
  file_path text not null,
  guide_text text,
  active boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(version)
);

alter table public.inventory_excel_templates add column if not exists columns jsonb not null default '[]'::jsonb;
alter table public.inventory_excel_templates add column if not exists validation_rules jsonb not null default '{}'::jsonb;

create table if not exists public.inventory_import_jobs (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  source_path text not null,
  status text not null default 'UPLOADED' check (status in ('UPLOADED','VALIDATING','PREVIEW_READY','APPLYING','COMPLETED','FAILED')),
  preview jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 소비자 편의
create table if not exists public.recent_product_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key(user_id, product_id)
);
create index if not exists recent_product_views_user_idx on public.recent_product_views(user_id, viewed_at desc);

create table if not exists public.seller_favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, seller_id)
);

create table if not exists public.product_questions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  content text not null,
  secret boolean not null default false,
  status text not null default 'WAITING' check (status in ('WAITING','ANSWERED','HIDDEN')),
  answer_content text,
  answered_by uuid references public.profiles(id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_questions_product_idx on public.product_questions(product_id, created_at desc);

create table if not exists public.form_drafts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  draft_key text not null,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '30 days'),
  updated_at timestamptz not null default now(),
  primary key(user_id, draft_key)
);

-- 쿠폰/포인트
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references public.sellers(id) on delete cascade,
  code text not null unique,
  name text not null,
  description text,
  discount_type text not null check (discount_type in ('FIXED','PERCENT')),
  discount_value bigint not null check (discount_value > 0),
  minimum_order_amount bigint not null default 0,
  maximum_discount_amount bigint,
  total_issue_limit integer,
  per_user_limit integer not null default 1,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','PAUSED','ENDED')),
  scope text not null default 'ALL' check (scope in ('ALL','PRODUCT','SELLER')),
  product_id uuid references public.products(id) on delete cascade,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.coupon_issues (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE','RESERVED','USED','EXPIRED','CANCELED')),
  reserved_order_id uuid references public.orders(id) on delete set null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  unique(coupon_id, user_id)
);
create index if not exists coupon_issues_user_idx on public.coupon_issues(user_id, status, expires_at);

create table if not exists public.point_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  available_balance bigint not null default 0 check (available_balance >= 0),
  reserved_balance bigint not null default 0 check (reserved_balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  entry_type text not null check (entry_type in ('EARN','USE','RESERVE','RELEASE','EXPIRE','ADJUST')),
  amount bigint not null,
  balance_after bigint not null,
  reason text not null,
  idempotency_key text not null unique,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- 주문/결제
alter table public.orders add column if not exists checkout_key text unique;
alter table public.orders add column if not exists idempotency_key text unique;
alter table public.orders add column if not exists coupon_issue_id uuid references public.coupon_issues(id) on delete set null;
alter table public.orders add column if not exists points_used bigint not null default 0;
alter table public.orders add column if not exists payment_id uuid;
alter table public.orders add column if not exists confirmed_at timestamptz;
alter table public.orders add column if not exists canceled_at timestamptz;
alter table public.orders add column if not exists expires_at timestamptz;
alter table public.order_items add column if not exists option_id uuid references public.product_options(id) on delete set null;
alter table public.order_items add column if not exists reward_points bigint not null default 0;

create table if not exists public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  provider text not null default 'TOSS',
  provider_payment_key text unique,
  provider_order_id text not null unique,
  amount bigint not null check (amount >= 0),
  balance_amount bigint not null default 0,
  status text not null default 'READY' check (status in ('READY','IN_PROGRESS','WAITING_FOR_DEPOSIT','DONE','CANCELED','PARTIAL_CANCELED','ABORTED','EXPIRED','FAILED')),
  method text,
  secret text,
  raw_response jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  attempt_type text not null,
  idempotency_key text not null unique,
  status text not null default 'STARTED',
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.payment_webhook_events (
  transmission_id text primary key,
  event_type text not null,
  payment_key text,
  order_id text,
  payload jsonb not null,
  verified boolean not null default false,
  processing_status text not null default 'RECEIVED',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text
);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  payment_id uuid not null references public.payments(id) on delete restrict,
  claim_id uuid references public.claims(id) on delete set null,
  refund_amount bigint not null check (refund_amount > 0),
  reason text not null,
  status text not null default 'REQUESTED' check (status in ('REQUESTED','PROCESSING','DONE','FAILED')),
  provider_transaction_key text,
  raw_response jsonb not null default '{}'::jsonb,
  requested_by uuid references public.profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

-- 배송/클레임
create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete restrict,
  status text not null default 'READY' check (status in ('READY','PREPARING','SHIPPED','IN_TRANSIT','DELIVERED','RETURN_REQUESTED','RETURNED','CANCELED')),
  carrier_code text,
  carrier_name text,
  tracking_number text,
  label_path text,
  prepared_at timestamptz,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id, seller_id)
);
create index if not exists shipments_seller_idx on public.shipments(seller_id, status, created_at desc);

create table if not exists public.shipment_events (
  id bigint generated always as identity primary key,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status text not null,
  event_time timestamptz not null default now(),
  location text,
  description text,
  raw_payload jsonb not null default '{}'::jsonb
);

alter table public.claims add column if not exists return_method text;
alter table public.claims add column if not exists exchange_option_id uuid references public.product_options(id) on delete set null;
alter table public.claims add column if not exists seller_memo text;
alter table public.claims add column if not exists admin_memo text;
alter table public.claims add column if not exists request_key text unique;
alter table public.claims add column if not exists approved_at timestamptz;
alter table public.claims add column if not exists completed_at timestamptz;

create table if not exists public.claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  object_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.claim_history (
  id bigint generated always as identity primary key,
  claim_id uuid not null references public.claims(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status text not null,
  memo text,
  created_at timestamptz not null default now()
);

-- 정산/지급
create table if not exists public.seller_settlement_accounts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null unique references public.sellers(id) on delete cascade,
  bank_code text not null,
  bank_name text not null,
  account_holder text not null,
  account_number_encrypted text not null,
  account_number_last4 text not null,
  account_type text not null default 'BUSINESS',
  verification_status text not null default 'PENDING' check (verification_status in ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  consented_at timestamptz not null,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  rejection_reason text,
  updated_at timestamptz not null default now()
);

create table if not exists public.settlement_policies (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  platform_fee_bps integer not null check (platform_fee_bps between 0 and 10000),
  settlement_delay_days integer not null default 7,
  effective_from date not null,
  active boolean not null default false,
  locked boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_number text not null unique default ('ST-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  seller_id uuid not null references public.sellers(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  gross_amount bigint not null default 0,
  refund_amount bigint not null default 0,
  fee_amount bigint not null default 0,
  net_amount bigint not null default 0,
  status text not null default 'DRAFT' check (status in ('DRAFT','CALCULATED','APPROVAL_PENDING','APPROVED','HOLD','PAYOUT_REQUESTED','COMPLETED','FAILED')),
  hold_reason text,
  policy_id uuid references public.settlement_policies(id),
  first_approved_by uuid references public.profiles(id),
  second_approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create table if not exists public.settlement_items (
  id bigint generated always as identity primary key,
  settlement_id uuid not null references public.settlements(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  gross_amount bigint not null,
  refund_amount bigint not null default 0,
  fee_amount bigint not null,
  net_amount bigint not null,
  unique(settlement_id, order_item_id)
);

create table if not exists public.payout_requests (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null unique references public.settlements(id) on delete restrict,
  seller_id uuid not null references public.sellers(id) on delete restrict,
  provider text not null default 'TOSS_PAYOUT',
  provider_payout_id text unique,
  idempotency_key text not null unique,
  amount bigint not null check (amount > 0),
  status text not null default 'REQUESTED' check (status in ('REQUESTED','PROCESSING','COMPLETED','FAILED','REJECTED','CANCELED')),
  raw_response jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 운영/관리
create table if not exists public.marketing_messages (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete cascade,
  audience text not null,
  message text not null check (char_length(message) between 2 and 1000),
  status text not null default 'QUEUED' check (status in ('QUEUED','SENDING','SENT','FAILED','CANCELED')),
  target_count integer not null default 0,
  sent_count integer not null default 0,
  requested_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  message text not null,
  stack text,
  url text,
  user_agent text,
  build_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_approval_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING_SECOND_APPROVAL' check (status in ('PENDING_SECOND_APPROVAL','APPROVED','REJECTED','EXPIRED')),
  requested_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table if not exists public.operation_readiness (
  control_key text primary key,
  category text not null,
  required_for_live boolean not null default true,
  status text not null default 'NOT_VERIFIED' check (status in ('NOT_VERIFIED','VERIFIED','EXPIRED','FAILED')),
  evidence_hash text,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  expires_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);

-- 기본 인덱스
create index if not exists orders_buyer_status_idx on public.orders(buyer_id, status, ordered_at desc);
create index if not exists order_items_seller_status_idx on public.order_items(seller_id, status, order_id);
create index if not exists claims_requester_idx on public.claims(requester_id, status, created_at desc);
create index if not exists claims_item_idx on public.claims(order_item_id, status);
create index if not exists payments_status_idx on public.payments(status, requested_at desc);
create index if not exists settlements_seller_idx on public.settlements(seller_id, status, period_end desc);
create index if not exists notifications_user_read_idx on public.notifications(user_id, read_at, created_at desc);

-- 기존 주문의 payment_id FK는 payments 생성 이후 추가
alter table public.orders drop constraint if exists orders_payment_id_fkey;
alter table public.orders add constraint orders_payment_id_fkey foreign key (payment_id) references public.payments(id) on delete set null;

-- updated_at 트리거
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'seller_applications','identity_verifications','seller_kyc','inventory_reservations',
    'inventory_excel_templates','inventory_import_jobs','product_questions','coupons','point_accounts',
    'payments','shipments','seller_settlement_accounts','settlements','payout_requests','operation_readiness'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()', t, t);
  END LOOP;
END $$;

-- 신규 사용자 포인트 계정도 생성
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, email, display_name, phone)
  values(
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email,''),'@',1)),
    nullif(new.raw_user_meta_data->>'phone','')
  ) on conflict(id) do update set email=excluded.email;
  insert into public.carts(user_id) values(new.id) on conflict(user_id) do nothing;
  insert into public.point_accounts(user_id) values(new.id) on conflict(user_id) do nothing;
  if jsonb_typeof(new.raw_user_meta_data->'consentReceipts')='array' then
    insert into public.consent_receipts(user_id,email,scope,policy_code,policy_version,content_hash,consented,client_submission_id,consented_at)
    select new.id,new.email,coalesce(x->>'scope','SIGNUP'),x->>'policyCode',coalesce(x->>'policyVersion','current'),coalesce(x->>'contentHash','CLIENT_RECORDED'),coalesce((x->>'consented')::boolean,true),coalesce(x->>'clientSubmissionId',new.id::text),now()
    from jsonb_array_elements(new.raw_user_meta_data->'consentReceipts') x
    where nullif(x->>'policyCode','') is not null
    on conflict do nothing;
  end if;
  return new;
end $$;

-- 공개 사업장 주소의 세부 호수는 저장하지 않음
update public.business_information
set public_business_address = regexp_replace(public_business_address, ',?\s*[0-9]+호\s*$', '')
where public_business_address ~ '[0-9]+호\s*$';
