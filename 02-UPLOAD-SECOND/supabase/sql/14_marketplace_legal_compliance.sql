-- Part 46: 오픈마켓 법적·운영 통제 구조
-- 목적: 통신판매중개 고지, 판매자 신원 스냅샷, 분쟁 SLA, 약관 버전, 정산 유보·조정, 증빙 보존

begin;

create or replace function public.add_business_days(p_start timestamptz, p_days integer)
returns timestamptz
language plpgsql
stable
set search_path=public
as $$
declare
  v_result timestamptz := p_start;
  v_added integer := 0;
begin
  if p_days < 0 then raise exception 'BUSINESS_DAYS_MUST_BE_NONNEGATIVE'; end if;
  while v_added < p_days loop
    v_result := v_result + interval '1 day';
    if extract(isodow from v_result) between 1 and 5 then
      v_added := v_added + 1;
    end if;
  end loop;
  return v_result;
end;
$$;

alter table public.sellers add column if not exists legal_name text;
alter table public.sellers add column if not exists mail_order_report_number text;
alter table public.sellers add column if not exists mail_order_report_agency text;
alter table public.sellers add column if not exists business_status text not null default 'UNVERIFIED';
alter table public.sellers add column if not exists return_address text;
alter table public.sellers add column if not exists contract_version text;
alter table public.sellers add column if not exists contract_accepted_at timestamptz;
alter table public.sellers add column if not exists risk_hold boolean not null default false;
alter table public.sellers add column if not exists risk_hold_reason text;

alter table public.products add column if not exists product_info_notice jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists seller_disclosure_snapshot jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists return_policy_snapshot jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists compliance_status text not null default 'INCOMPLETE';
alter table public.products add column if not exists compliance_flags jsonb not null default '[]'::jsonb;
alter table public.products add column if not exists compliance_reviewed_at timestamptz;
alter table public.products add column if not exists compliance_reviewed_by uuid references public.profiles(id);
alter table public.products add column if not exists prohibited_claim_check boolean not null default false;

alter table public.orders add column if not exists intermediary_notice_version text;
alter table public.orders add column if not exists terms_snapshot jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists seller_identity_snapshot jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists buyer_confirmation_snapshot jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists legal_hold boolean not null default false;

alter table public.order_items add column if not exists seller_info_snapshot jsonb not null default '{}'::jsonb;
alter table public.order_items add column if not exists product_info_snapshot jsonb not null default '{}'::jsonb;
alter table public.order_items add column if not exists return_policy_snapshot jsonb not null default '{}'::jsonb;
alter table public.order_items add column if not exists compliance_snapshot jsonb not null default '{}'::jsonb;

create table if not exists public.marketplace_disclosures (
  code text primary key,
  version text not null,
  title text not null,
  content text not null,
  disclosure_type text not null check (disclosure_type in ('INTERMEDIARY','SELLER_IDENTITY','RETURN_REFUND','PRIVACY','PAYMENT_SAFETY','FOOD_SAFETY','OTHER')),
  active boolean not null default true,
  required_at text[] not null default array['FOOTER']::text[],
  legal_review_status text not null default 'DRAFT' check (legal_review_status in ('DRAFT','REVIEW_REQUIRED','APPROVED','REJECTED')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.seller_contract_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  title text not null,
  body text not null,
  content_hash text not null,
  fee_schedule jsonb not null default '{}'::jsonb,
  settlement_terms jsonb not null default '{}'::jsonb,
  sanctions_policy jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  legal_review_status text not null default 'REVIEW_REQUIRED' check (legal_review_status in ('DRAFT','REVIEW_REQUIRED','APPROVED','REJECTED')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  effective_from timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.seller_contract_acceptances (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete cascade,
  contract_version_id uuid not null references public.seller_contract_versions(id) on delete restrict,
  accepted_by uuid not null references public.profiles(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  ip_hash text,
  user_agent_hash text,
  acceptance_evidence jsonb not null default '{}'::jsonb,
  unique(seller_id, contract_version_id)
);

create table if not exists public.dispute_cases (
  id uuid primary key default gen_random_uuid(),
  case_number text not null unique default ('DSP-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  order_id uuid references public.orders(id) on delete restrict,
  order_item_id uuid references public.order_items(id) on delete restrict,
  claimant_id uuid references public.profiles(id) on delete set null,
  seller_id uuid references public.sellers(id) on delete set null,
  case_type text not null check (case_type in ('DELIVERY','QUALITY','QUANTITY','MISDESCRIPTION','PAYMENT','REFUND','PRIVACY','SELLER','OTHER')),
  title text not null,
  description text not null,
  status text not null default 'RECEIVED' check (status in ('RECEIVED','INVESTIGATING','SELLER_RESPONSE_PENDING','BUYER_RESPONSE_PENDING','MEDIATION','RESOLVED','REJECTED','CLOSED')),
  priority text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','CRITICAL')),
  first_response_due_at timestamptz not null default public.add_business_days(now(), 3),
  resolution_due_at timestamptz not null default public.add_business_days(now(), 10),
  first_response_at timestamptz,
  resolved_at timestamptz,
  resolution_summary text,
  liability_party text check (liability_party is null or liability_party in ('PLATFORM','SELLER','BUYER','CARRIER','SHARED','UNDETERMINED')),
  compensation_amount bigint not null default 0 check (compensation_amount >= 0),
  evidence jsonb not null default '[]'::jsonb,
  assigned_admin_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dispute_cases_status_due_idx on public.dispute_cases(status, first_response_due_at, resolution_due_at);

create table if not exists public.dispute_events (
  id bigint generated always as identity primary key,
  dispute_id uuid not null references public.dispute_cases(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  message text,
  before_state jsonb,
  after_state jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.legal_holds (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  reason text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RELEASED')),
  placed_by uuid not null references public.profiles(id),
  placed_at timestamptz not null default now(),
  released_by uuid references public.profiles(id),
  released_at timestamptz,
  unique(entity_type, entity_id, status)
);

create table if not exists public.record_retention_policies (
  record_type text primary key,
  retention_months integer not null check (retention_months between 1 and 240),
  legal_basis text not null,
  deletion_mode text not null default 'MASK' check (deletion_mode in ('DELETE','MASK','ARCHIVE')),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.seller_performance_daily (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  metric_date date not null,
  orders_count integer not null default 0,
  shipped_on_time_count integer not null default 0,
  late_shipment_count integer not null default 0,
  seller_cancel_count integer not null default 0,
  quality_claim_count integer not null default 0,
  refund_amount bigint not null default 0,
  response_within_sla_count integer not null default 0,
  response_due_count integer not null default 0,
  score numeric(6,2) not null default 100,
  created_at timestamptz not null default now(),
  primary key(seller_id, metric_date)
);

create table if not exists public.seller_sanctions (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete cascade,
  sanction_type text not null check (sanction_type in ('WARNING','EXPOSURE_LIMIT','PRODUCT_STOP','SETTLEMENT_HOLD','ACCOUNT_SUSPEND','ACCOUNT_TERMINATE')),
  reason_code text not null,
  reason_detail text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','APPEALED','REVOKED','EXPIRED')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.settlement_reserves (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete restrict,
  settlement_id uuid references public.settlements(id) on delete restrict,
  amount bigint not null check (amount >= 0),
  reserve_type text not null check (reserve_type in ('REFUND_BUFFER','CLAIM_BUFFER','RISK_HOLD','LEGAL_HOLD','CHARGEBACK')),
  status text not null default 'HELD' check (status in ('HELD','PARTIALLY_RELEASED','RELEASED','APPLIED')),
  reason text not null,
  held_at timestamptz not null default now(),
  release_due_at timestamptz,
  released_at timestamptz,
  created_by uuid references public.profiles(id)
);

create table if not exists public.settlement_adjustments (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete restrict,
  settlement_id uuid references public.settlements(id) on delete restrict,
  order_item_id uuid references public.order_items(id) on delete restrict,
  adjustment_type text not null check (adjustment_type in ('REFUND','SHIPPING','COUPON_SHARE','FEE_CORRECTION','PENALTY','COMPENSATION','TAX','OTHER')),
  amount bigint not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','APPLIED','REJECTED')),
  requested_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table if not exists public.settlement_reconciliations (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  reconciliation_date date not null,
  source_count integer not null default 0,
  source_amount bigint not null default 0,
  internal_count integer not null default 0,
  internal_amount bigint not null default 0,
  mismatch_count integer not null default 0,
  mismatch_amount bigint not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING','MATCHED','MISMATCH','RESOLVED')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(provider, reconciliation_date)
);

create table if not exists public.tax_documents (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete restrict,
  settlement_id uuid references public.settlements(id) on delete restrict,
  document_type text not null check (document_type in ('SETTLEMENT_STATEMENT','TAX_INVOICE','WITHHOLDING','VAT_REPORT','OTHER')),
  period_start date,
  period_end date,
  document_number text,
  file_path text,
  status text not null default 'PENDING' check (status in ('PENDING','ISSUED','FAILED','CANCELED')),
  issued_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.operator_action_evidence (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  entity_type text not null,
  entity_id text not null,
  actor_id uuid references public.profiles(id),
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  before_hash text,
  after_hash text,
  created_at timestamptz not null default now()
);

create or replace function public.snapshot_marketplace_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seller_rows jsonb;
  disclosure_row record;
begin
  select jsonb_agg(jsonb_build_object(
    'sellerId', s.id,
    'storeName', s.store_name,
    'legalName', coalesce(s.legal_name, s.store_name),
    'representativeName', s.representative_name,
    'businessNumber', s.business_number,
    'businessAddress', s.business_address,
    'mailOrderReportNumber', s.mail_order_report_number,
    'mailOrderReportAgency', s.mail_order_report_agency,
    'customerServicePhone', s.customer_service_phone,
    'customerServiceEmail', s.customer_service_email
  )) into seller_rows
  from public.order_items oi join public.sellers s on s.id = oi.seller_id
  where oi.order_id = new.id;

  select * into disclosure_row from public.marketplace_disclosures
  where code = 'INTERMEDIARY_NOTICE' and active = true
  order by effective_from desc limit 1;

  update public.orders
  set seller_identity_snapshot = coalesce(seller_rows, '[]'::jsonb),
      intermediary_notice_version = coalesce(disclosure_row.version, intermediary_notice_version),
      terms_snapshot = jsonb_build_object(
        'intermediaryNotice', coalesce(disclosure_row.content, ''),
        'capturedAt', now()
      )
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_snapshot_marketplace_order on public.order_items;
create constraint trigger trg_snapshot_marketplace_order
after insert or update on public.order_items
deferrable initially deferred
for each row execute function public.snapshot_marketplace_order();

create or replace function public.open_dispute_case(
  p_order_id uuid,
  p_order_item_id uuid,
  p_case_type text,
  p_title text,
  p_description text,
  p_evidence jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_seller uuid;
  v_case uuid;
begin
  perform public.assert_active_user();
  if not exists(select 1 from public.orders where id = p_order_id and buyer_id = v_user) then
    raise exception 'ORDER_NOT_OWNED';
  end if;
  select seller_id into v_seller from public.order_items where id = p_order_item_id and order_id = p_order_id;
  if v_seller is null then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  insert into public.dispute_cases(order_id, order_item_id, claimant_id, seller_id, case_type, title, description, evidence)
  values(p_order_id, p_order_item_id, v_user, v_seller, upper(p_case_type), p_title, p_description, coalesce(p_evidence,'[]'::jsonb))
  returning id into v_case;
  insert into public.dispute_events(dispute_id, actor_id, event_type, message, after_state)
  values(v_case, v_user, 'RECEIVED', p_description, jsonb_build_object('status','RECEIVED'));
  return v_case;
end;
$$;

create or replace function public.transition_dispute_case(
  p_case_id uuid,
  p_status text,
  p_message text,
  p_resolution_summary text default null,
  p_liability_party text default null,
  p_compensation_amount bigint default 0
) returns public.dispute_cases
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.dispute_cases;
  v_after public.dispute_cases;
  v_role text := public.current_app_role();
begin
  if v_role not in ('admin','seller') then raise exception 'ROLE_FORBIDDEN'; end if;
  select * into v_before from public.dispute_cases where id = p_case_id for update;
  if v_before.id is null then raise exception 'DISPUTE_NOT_FOUND'; end if;
  if v_role = 'seller' and v_before.seller_id <> public.current_seller_id() then raise exception 'DISPUTE_FORBIDDEN'; end if;
  update public.dispute_cases
  set status = upper(p_status),
      first_response_at = coalesce(first_response_at, now()),
      resolved_at = case when upper(p_status) in ('RESOLVED','REJECTED','CLOSED') then now() else resolved_at end,
      resolution_summary = coalesce(p_resolution_summary, resolution_summary),
      liability_party = coalesce(p_liability_party, liability_party),
      compensation_amount = greatest(0, coalesce(p_compensation_amount, compensation_amount)),
      updated_at = now()
  where id = p_case_id returning * into v_after;
  insert into public.dispute_events(dispute_id, actor_id, event_type, message, before_state, after_state)
  values(p_case_id, auth.uid(), 'STATUS_CHANGED', p_message, to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$$;

insert into public.record_retention_policies(record_type, retention_months, legal_basis, deletion_mode) values
  ('ADVERTISING', 6, '전자상거래 거래기록 보존', 'ARCHIVE'),
  ('CONTRACT_WITHDRAWAL', 60, '전자상거래 거래기록 보존', 'ARCHIVE'),
  ('PAYMENT_SUPPLY', 60, '전자상거래 거래기록 보존', 'ARCHIVE'),
  ('COMPLAINT_DISPUTE', 36, '전자상거래 거래기록 보존', 'ARCHIVE'),
  ('ACCESS_LOG', 12, '개인정보 안전성 확보조치', 'ARCHIVE')
on conflict(record_type) do update set retention_months = excluded.retention_months, legal_basis = excluded.legal_basis, deletion_mode = excluded.deletion_mode, updated_at = now();

insert into public.marketplace_disclosures(code, version, title, content, disclosure_type, required_at, legal_review_status)
values
('INTERMEDIARY_NOTICE','2026-08-draft','통신판매중개 안내','푸릇마켓은 개별 판매자가 판매하는 상품의 통신판매중개자이며 상품 판매의 당사자는 각 상품 상세에 표시된 판매자입니다. 다만 관련 법령에 따른 중개자의 의무, 분쟁 접수 및 피해 파악·조치를 수행합니다.','INTERMEDIARY',array['FOOTER','PRODUCT','CHECKOUT'],'REVIEW_REQUIRED'),
('FRESH_RETURN_NOTICE','2026-08-draft','신선식품 교환·환불 안내','신선식품의 단순 변심 철회 제한은 상품 특성 및 사전 고지 요건을 충족하는 범위에서만 적용됩니다. 오배송, 하자, 표시와 다른 품질, 부패·파손은 판매자와 플랫폼의 확인 절차에 따라 교환·환불 대상이 될 수 있습니다.','RETURN_REFUND',array['PRODUCT','CHECKOUT','CLAIM'],'REVIEW_REQUIRED'),
('PAYMENT_SAFETY_NOTICE','2026-08-draft','구매안전 안내','결제와 환불은 계약된 PG 및 구매안전 절차를 통해 처리하며 플랫폼 또는 판매자 개인계좌로 별도 송금을 요구하지 않습니다.','PAYMENT_SAFETY',array['CHECKOUT','FOOTER'],'REVIEW_REQUIRED')
on conflict(code) do update set version=excluded.version,title=excluded.title,content=excluded.content,required_at=excluded.required_at,updated_at=now();

-- RLS
alter table public.marketplace_disclosures enable row level security;
alter table public.seller_contract_versions enable row level security;
alter table public.seller_contract_acceptances enable row level security;
alter table public.dispute_cases enable row level security;
alter table public.dispute_events enable row level security;
alter table public.legal_holds enable row level security;
alter table public.record_retention_policies enable row level security;
alter table public.seller_performance_daily enable row level security;
alter table public.seller_sanctions enable row level security;
alter table public.settlement_reserves enable row level security;
alter table public.settlement_adjustments enable row level security;
alter table public.settlement_reconciliations enable row level security;
alter table public.tax_documents enable row level security;
alter table public.operator_action_evidence enable row level security;

drop policy if exists marketplace_disclosures_public_read on public.marketplace_disclosures;
create policy marketplace_disclosures_public_read on public.marketplace_disclosures for select using (active and legal_review_status = 'APPROVED');

drop policy if exists seller_contract_versions_admin_read on public.seller_contract_versions;
create policy seller_contract_versions_admin_read on public.seller_contract_versions for select using (public.is_admin() or active);

drop policy if exists seller_contract_acceptances_owner_read on public.seller_contract_acceptances;
create policy seller_contract_acceptances_owner_read on public.seller_contract_acceptances for select using (public.is_admin() or exists(select 1 from public.sellers s where s.id=seller_id and s.owner_id=auth.uid()));

drop policy if exists dispute_cases_participant_read on public.dispute_cases;
create policy dispute_cases_participant_read on public.dispute_cases for select using (
  public.is_admin() or claimant_id=auth.uid() or exists(select 1 from public.sellers s where s.id=seller_id and s.owner_id=auth.uid())
);
drop policy if exists dispute_events_participant_read on public.dispute_events;
create policy dispute_events_participant_read on public.dispute_events for select using (exists(select 1 from public.dispute_cases d where d.id=dispute_id and (public.is_admin() or d.claimant_id=auth.uid() or exists(select 1 from public.sellers s where s.id=d.seller_id and s.owner_id=auth.uid()))));

-- 민감 운영 테이블은 서비스 역할/관리자 API만 사용하며 브라우저 직접 쓰기 차단
revoke all on public.legal_holds, public.record_retention_policies, public.seller_sanctions, public.settlement_reserves, public.settlement_adjustments, public.settlement_reconciliations, public.operator_action_evidence from anon, authenticated;
grant select on public.marketplace_disclosures to anon, authenticated;
grant select on public.dispute_cases, public.dispute_events to authenticated;
grant execute on function public.open_dispute_case(uuid,uuid,text,text,text,jsonb) to authenticated;
grant execute on function public.transition_dispute_case(uuid,text,text,text,text,bigint) to authenticated;

commit;
