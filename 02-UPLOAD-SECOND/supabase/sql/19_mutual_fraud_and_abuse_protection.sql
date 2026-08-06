-- 푸릇마켓 Part 48: 판매자·구매자 상호 부정행위 방지 및 적법한 이의제기 절차
-- 원칙: 위험점수만으로 최종 불이익을 자동 확정하지 않는다. 긴급한 피해 확산 방지를 위한 임시조치 후 통지·수동심사·이의제기를 보장한다.
begin;

create extension if not exists pgcrypto;

create table if not exists public.trust_risk_rules (
  rule_code text primary key,
  actor_scope text not null check (actor_scope in ('BUYER','SELLER','ACCOUNT','ORDER','PAYMENT','CLAIM','PLATFORM')),
  title text not null,
  description text not null,
  default_points integer not null check (default_points between 0 and 100),
  severity text not null check (severity in ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  automatic_temporary_action text,
  final_action_requires_manual_review boolean not null default true,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.entity_trust_profiles (
  entity_type text not null check (entity_type in ('BUYER','SELLER','ACCOUNT','ORDER','PAYMENT','CLAIM')),
  entity_id text not null,
  risk_score integer not null default 0 check (risk_score between 0 and 100),
  risk_level text not null default 'NORMAL' check (risk_level in ('NORMAL','WATCH','REVIEW','HOLD','BLOCKED')),
  confirmed_abuse_count integer not null default 0,
  dismissed_signal_count integer not null default 0,
  last_signal_at timestamptz,
  last_manual_review_at timestamptz,
  final_adverse_action boolean not null default false,
  final_action_reason text,
  updated_at timestamptz not null default now(),
  primary key(entity_type, entity_id),
  check (not final_adverse_action or last_manual_review_at is not null)
);

create table if not exists public.trust_risk_signals (
  id uuid primary key default gen_random_uuid(),
  rule_code text not null references public.trust_risk_rules(rule_code),
  entity_type text not null check (entity_type in ('BUYER','SELLER','ACCOUNT','ORDER','PAYMENT','CLAIM')),
  entity_id text not null,
  related_order_id uuid references public.orders(id) on delete set null,
  related_claim_id uuid references public.claims(id) on delete set null,
  source text not null,
  points integer not null check (points between 0 and 100),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CONFIRMED','DISMISSED','EXPIRED')),
  facts jsonb not null default '{}'::jsonb,
  evidence_hash text,
  idempotency_key text unique,
  detected_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_memo text,
  expires_at timestamptz
);
create index if not exists trust_risk_signals_entity_idx on public.trust_risk_signals(entity_type,entity_id,status,detected_at desc);
create index if not exists trust_risk_signals_order_idx on public.trust_risk_signals(related_order_id) where related_order_id is not null;

create table if not exists public.trust_review_cases (
  id uuid primary key default gen_random_uuid(),
  case_number text not null unique default ('TRS-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  subject_type text not null check (subject_type in ('BUYER','SELLER','ACCOUNT','ORDER','PAYMENT','CLAIM')),
  subject_id text not null,
  case_type text not null check (case_type in ('SELLER_MISCONDUCT','BUYER_ABUSE','ACCOUNT_TAKEOVER','PAYMENT_FRAUD','REFUND_ABUSE','DELIVERY_DISPUTE','COUPON_ABUSE','COLLUSION','OTHER')),
  status text not null default 'OPEN' check (status in ('OPEN','EVIDENCE_PENDING','INVESTIGATING','NOTICE_SENT','DECISION_PENDING','RESOLVED','DISMISSED','CLOSED')),
  priority text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','CRITICAL')),
  summary text not null,
  opening_facts jsonb not null default '{}'::jsonb,
  temporary_action text,
  temporary_action_expires_at timestamptz,
  emergency_action boolean not null default false,
  notice_due_at timestamptz not null default public.add_business_days(now(),3),
  decision_due_at timestamptz not null default public.add_business_days(now(),10),
  notice_sent_at timestamptz,
  decision text check (decision is null or decision in ('NO_ABUSE','WARNING','LIMITED_RESTRICTION','HOLD_CONTINUE','SUSPEND','TERMINATE','COMPENSATE','RECOVER_LOSS','SHARED_RESPONSIBILITY')),
  decision_reason text,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  manual_review_required boolean not null default true,
  automatic_final_decision boolean not null default false check (automatic_final_decision = false),
  appeal_deadline timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists trust_review_cases_one_active_idx on public.trust_review_cases(subject_type,subject_id,case_type)
where status not in ('RESOLVED','DISMISSED','CLOSED');

create table if not exists public.trust_case_evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.trust_review_cases(id) on delete cascade,
  submitted_by uuid references public.profiles(id),
  party_type text not null check (party_type in ('BUYER','SELLER','PLATFORM','CARRIER','PG','OTHER')),
  evidence_type text not null check (evidence_type in ('PHOTO','VIDEO','DOCUMENT','DELIVERY_SCAN','PACKAGE_WEIGHT','SYSTEM_LOG','MESSAGE','PAYMENT_RECORD','PRODUCT_SNAPSHOT','OTHER')),
  object_path text,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  captured_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists trust_case_evidence_hash_idx on public.trust_case_evidence(case_id,content_hash);

create table if not exists public.trust_case_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.trust_review_cases(id) on delete cascade,
  action_type text not null check (action_type in ('NOTICE','EVIDENCE_REQUEST','CHECKOUT_REVIEW','REFUND_REVIEW','PAYOUT_HOLD','ACCOUNT_CHANGE_HOLD','COUPON_LIMIT','PRODUCT_STOP','EXPOSURE_LIMIT','LOGIN_CHALLENGE','ACCOUNT_SUSPEND','ACCOUNT_TERMINATE','RELEASE','COMPENSATION','RECOVERY')),
  action_scope jsonb not null default '{}'::jsonb,
  reason text not null,
  temporary boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','EXPIRED','REVOKED','COMPLETED')),
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (temporary or approved_by is not null)
);
create index if not exists trust_case_actions_active_idx on public.trust_case_actions(action_type,status,ends_at);

create table if not exists public.trust_appeals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.trust_review_cases(id) on delete cascade,
  appellant_id uuid not null references public.profiles(id),
  appellant_type text not null check (appellant_type in ('BUYER','SELLER')),
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,
  status text not null default 'RECEIVED' check (status in ('RECEIVED','INVESTIGATING','ACCEPTED','PARTIALLY_ACCEPTED','REJECTED','CLOSED')),
  assigned_admin_id uuid references public.profiles(id),
  resolution text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(case_id,appellant_id)
);

create table if not exists public.trust_case_decision_approvals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.trust_review_cases(id) on delete cascade,
  approver_id uuid not null references public.profiles(id),
  approval_type text not null default 'FINAL_ADVERSE' check (approval_type in ('FINAL_ADVERSE','LOSS_RECOVERY')),
  decision text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique(case_id,approver_id,approval_type,decision)
);
create index if not exists trust_case_decision_approvals_case_idx on public.trust_case_decision_approvals(case_id,approval_type,created_at desc);

create table if not exists public.delivery_evidence_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  shipment_id uuid references public.shipments(id) on delete set null,
  seller_id uuid references public.sellers(id) on delete set null,
  evidence_type text not null check (evidence_type in ('PICKUP_SCAN','IN_TRANSIT_SCAN','DELIVERY_SCAN','DELIVERY_PHOTO','RECEIPT_CONFIRMATION','PACKAGE_WEIGHT','TEMPERATURE_LOG','OTHER')),
  provider text,
  provider_event_id text,
  content_hash text not null,
  object_path text,
  event_at timestamptz not null,
  location_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider,provider_event_id)
);

create table if not exists public.return_inspections (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null unique references public.claims(id) on delete restrict,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  seller_id uuid not null references public.sellers(id) on delete restrict,
  inspected_by uuid references public.profiles(id),
  received_at timestamptz,
  package_weight_grams integer check (package_weight_grams is null or package_weight_grams >= 0),
  expected_weight_grams integer check (expected_weight_grams is null or expected_weight_grams >= 0),
  seal_status text check (seal_status is null or seal_status in ('INTACT','BROKEN','NOT_APPLICABLE','UNKNOWN')),
  item_match_status text check (item_match_status is null or item_match_status in ('MATCH','MISMATCH','PARTIAL','UNDETERMINED')),
  quality_status text check (quality_status is null or quality_status in ('SELLABLE','DAMAGED','CONSUMED','SPOILED','EMPTY_PACKAGE','WRONG_ITEM','UNDETERMINED')),
  inspection_result text not null default 'PENDING' check (inspection_result in ('PENDING','BUYER_FAULT_INDICATOR','SELLER_FAULT_INDICATOR','CARRIER_FAULT_INDICATOR','NO_FAULT','INCONCLUSIVE')),
  evidence jsonb not null default '[]'::jsonb,
  memo text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_security_events (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('BUYER','SELLER','ADMIN')),
  actor_id uuid references public.profiles(id),
  seller_id uuid references public.sellers(id),
  event_type text not null check (event_type in ('PASSWORD_CHANGED','EMAIL_CHANGED','PHONE_CHANGED','SETTLEMENT_ACCOUNT_CHANGED','PAYOUT_DESTINATION_CHANGED','MFA_CHANGED','NEW_DEVICE','RECOVERY_COMPLETED','OTHER')),
  risk_level text not null default 'LOW' check (risk_level in ('LOW','MEDIUM','HIGH','CRITICAL')),
  old_value_hash text,
  new_value_hash text,
  device_hash text,
  ip_hash text,
  cooling_off_until timestamptz,
  confirmed_by_mfa boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists account_security_events_seller_idx on public.account_security_events(seller_id,created_at desc);

create table if not exists public.refund_request_reviews (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  claim_id uuid references public.claims(id) on delete restrict,
  requester_id uuid references public.profiles(id),
  requested_amount bigint not null check (requested_amount > 0),
  risk_decision text not null check (risk_decision in ('ALLOW','REVIEW','DUPLICATE_BLOCK')),
  risk_reasons text[] not null default '{}',
  case_id uuid references public.trust_review_cases(id),
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','PAID','CLOSED')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists refund_request_reviews_one_open_idx on public.refund_request_reviews(payment_id,coalesce(claim_id,'00000000-0000-0000-0000-000000000000'::uuid),requested_amount)
where status in ('PENDING','APPROVED');

insert into public.trust_risk_rules(rule_code,actor_scope,title,description,default_points,severity,automatic_temporary_action) values
('SELLER_FALSE_TRACKING','SELLER','허위 또는 재사용 송장 의심','배송사 조회 불가·다른 주문과 중복된 송장 등 객관적 신호',35,'HIGH','PAYOUT_HOLD'),
('SELLER_NON_SHIPMENT_CLUSTER','SELLER','반복 미출고·품절 취소','출고기한 위반 또는 판매자 귀책 취소가 반복됨',25,'HIGH','EXPOSURE_LIMIT'),
('SELLER_MISDESCRIPTION_CLUSTER','SELLER','표시와 다른 상품 반복','원산지·품종·중량·등급 등 핵심정보 불일치가 반복됨',35,'HIGH','PRODUCT_STOP'),
('SELLER_RECALL_OR_UNSAFE_LOT','SELLER','리콜·위해 로트 판매','판매 차단 대상 로트가 주문에 배정되었거나 판매됨',70,'CRITICAL','PAYOUT_HOLD'),
('SELLER_PAYOUT_ACCOUNT_CHANGE','ACCOUNT','정산계좌 변경','정산계좌 변경 후 냉각기간과 재검증 필요',25,'HIGH','ACCOUNT_CHANGE_HOLD'),
('SELLER_REVIEW_MANIPULATION','SELLER','리뷰 조작·거래 담합 의심','동일 식별자·비정상 주문 패턴 등 조작 신호',30,'HIGH','EXPOSURE_LIMIT'),
('BUYER_REFUND_VELOCITY','BUYER','단기간 반복 환불 요청','최근 주문 대비 환불·반품 요청 비율과 빈도가 높음',20,'MEDIUM','REFUND_REVIEW'),
('BUYER_EMPTY_OR_SWITCH_RETURN','BUYER','빈 상자·상품 바꿔치기 의심','반품검수에서 중량·상품 일치 여부의 객관적 불일치',45,'HIGH','REFUND_REVIEW'),
('BUYER_DUPLICATE_REFUND','PAYMENT','중복 환불 요청','이미 환불된 금액 또는 동일 멱등키에 대한 재요청',100,'CRITICAL','REFUND_REVIEW'),
('BUYER_COUPON_MULTIACCOUNT','BUYER','다계정 쿠폰 악용 의심','해시 식별자·주소·기기 등의 다계정 중복 신호',25,'HIGH','COUPON_LIMIT'),
('BUYER_FALSE_NONDELIVERY','BUYER','배송완료 후 미수령 주장 반복','택배사 완료 스캔·수령확인과 상충하는 이력이 반복됨',25,'HIGH','REFUND_REVIEW'),
('ACCOUNT_TAKEOVER_SIGNAL','ACCOUNT','계정 탈취 의심','새 기기·복구·연락처·정산계좌 변경이 짧은 기간에 집중됨',60,'CRITICAL','LOGIN_CHALLENGE'),
('PAYMENT_CHARGEBACK_AFTER_REFUND','PAYMENT','환불 후 차지백 중복','환불 완료 거래에 대해 카드사 이의제기가 중복 접수됨',60,'CRITICAL','REFUND_REVIEW'),
('BUYER_FALSE_REPORT_PATTERN','BUYER','반복 허위신고 의심','수동심사에서 허위로 확인된 판매자 신고가 반복된 정황',25,'MEDIUM',null),
('SELLER_FALSE_REPORT_PATTERN','SELLER','반복 허위신고 의심','수동심사에서 허위로 확인된 구매자 신고가 반복된 정황',25,'MEDIUM',null)
on conflict(rule_code) do update set title=excluded.title,description=excluded.description,default_points=excluded.default_points,severity=excluded.severity,automatic_temporary_action=excluded.automatic_temporary_action,active=true,updated_at=now();

create or replace function public.trust_risk_level(p_score integer)
returns text language sql immutable as $$
  select case when p_score >= 80 then 'HOLD' when p_score >= 55 then 'REVIEW' when p_score >= 25 then 'WATCH' else 'NORMAL' end;
$$;

create or replace function public.recalculate_entity_trust(p_entity_type text,p_entity_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_score integer; v_confirmed integer; v_dismissed integer; v_level text; v_existing public.entity_trust_profiles;
begin
  select coalesce(sum(case when s.status='CONFIRMED' then least(100,s.points*2) when s.status='ACTIVE' then s.points else 0 end),0)::integer,
         count(*) filter(where s.status='CONFIRMED')::integer,
         count(*) filter(where s.status='DISMISSED')::integer
    into v_score,v_confirmed,v_dismissed
  from public.trust_risk_signals s
  where s.entity_type=upper(p_entity_type) and s.entity_id=p_entity_id
    and (s.expires_at is null or s.expires_at>now()) and s.detected_at>now()-interval '365 days';
  v_score:=least(100,greatest(0,v_score));
  select * into v_existing from public.entity_trust_profiles where entity_type=upper(p_entity_type) and entity_id=p_entity_id;
  v_level:=case when coalesce(v_existing.final_adverse_action,false) then 'BLOCKED' else public.trust_risk_level(v_score) end;
  insert into public.entity_trust_profiles(entity_type,entity_id,risk_score,risk_level,confirmed_abuse_count,dismissed_signal_count,last_signal_at,updated_at)
  values(upper(p_entity_type),p_entity_id,v_score,v_level,v_confirmed,v_dismissed,(select max(detected_at) from public.trust_risk_signals where entity_type=upper(p_entity_type) and entity_id=p_entity_id),now())
  on conflict(entity_type,entity_id) do update set risk_score=excluded.risk_score,risk_level=case when public.entity_trust_profiles.final_adverse_action then 'BLOCKED' else excluded.risk_level end,
    confirmed_abuse_count=excluded.confirmed_abuse_count,dismissed_signal_count=excluded.dismissed_signal_count,last_signal_at=excluded.last_signal_at,updated_at=now();
  return jsonb_build_object('entityType',upper(p_entity_type),'entityId',p_entity_id,'riskScore',v_score,'riskLevel',v_level,'confirmedAbuseCount',v_confirmed);
end $$;

create or replace function public.record_trust_risk_signal(p_rule_code text,p_entity_type text,p_entity_id text,p_source text,p_facts jsonb default '{}'::jsonb,p_order_id uuid default null,p_claim_id uuid default null,p_idempotency_key text default null,p_points integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_rule public.trust_risk_rules; v_signal uuid; v_points integer;
begin
  select * into v_rule from public.trust_risk_rules where rule_code=p_rule_code and active;
  if v_rule.rule_code is null then raise exception 'RISK_RULE_NOT_FOUND'; end if;
  v_points:=least(100,greatest(0,coalesce(p_points,v_rule.default_points)));
  insert into public.trust_risk_signals(rule_code,entity_type,entity_id,related_order_id,related_claim_id,source,points,facts,idempotency_key)
  values(v_rule.rule_code,upper(p_entity_type),p_entity_id,p_order_id,p_claim_id,p_source,v_points,coalesce(p_facts,'{}'::jsonb),p_idempotency_key)
  on conflict(idempotency_key) do update set facts=public.trust_risk_signals.facts||excluded.facts
  returning id into v_signal;
  return jsonb_build_object('signalId',v_signal,'profile',public.recalculate_entity_trust(upper(p_entity_type),p_entity_id));
end $$;

create or replace function public.open_trust_review_case(p_subject_type text,p_subject_id text,p_case_type text,p_summary text,p_facts jsonb default '{}'::jsonb,p_priority text default 'NORMAL',p_temporary_action text default null,p_temporary_hours integer default 72,p_emergency boolean default false)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_actor uuid:=auth.uid();
begin
  select id into v_id from public.trust_review_cases where subject_type=upper(p_subject_type) and subject_id=p_subject_id and case_type=upper(p_case_type) and status not in ('RESOLVED','DISMISSED','CLOSED') limit 1;
  if v_id is null then
    insert into public.trust_review_cases(subject_type,subject_id,case_type,summary,opening_facts,priority,temporary_action,temporary_action_expires_at,emergency_action,created_by)
    values(upper(p_subject_type),p_subject_id,upper(p_case_type),p_summary,coalesce(p_facts,'{}'::jsonb),upper(p_priority),p_temporary_action,case when p_temporary_action is null then null else now()+make_interval(hours=>greatest(1,least(720,p_temporary_hours))) end,p_emergency,v_actor)
    returning id into v_id;
    if p_temporary_action is not null then
      insert into public.trust_case_actions(case_id,action_type,reason,temporary,ends_at,created_by)
      values(v_id,p_temporary_action,p_summary,true,now()+make_interval(hours=>greatest(1,least(720,p_temporary_hours))),v_actor);
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.submit_trust_appeal(p_case_id uuid,p_reason text,p_evidence jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_uid uuid:=public.assert_active_user(); v_case public.trust_review_cases; v_type text; v_id uuid;
begin
  select * into v_case from public.trust_review_cases where id=p_case_id;
  if v_case.id is null then raise exception 'TRUST_CASE_NOT_FOUND'; end if;
  if v_case.subject_type='BUYER' and v_case.subject_id=v_uid::text then v_type:='BUYER';
  elsif v_case.subject_type='SELLER' and exists(select 1 from public.sellers where id::text=v_case.subject_id and owner_id=v_uid) then v_type:='SELLER';
  else raise exception 'TRUST_APPEAL_FORBIDDEN'; end if;
  if length(trim(coalesce(p_reason,'')))<10 then raise exception 'APPEAL_REASON_TOO_SHORT'; end if;
  insert into public.trust_appeals(case_id,appellant_id,appellant_type,reason,evidence)
  values(p_case_id,v_uid,v_type,p_reason,coalesce(p_evidence,'[]'::jsonb))
  on conflict(case_id,appellant_id) do update set reason=excluded.reason,evidence=excluded.evidence,status='RECEIVED',created_at=now(),resolved_at=null,resolution=null
  returning id into v_id;
  update public.trust_review_cases set status='INVESTIGATING',updated_at=now() where id=p_case_id and status not in ('DISMISSED','CLOSED');
  perform public.audit_event('TRUST_APPEAL_SUBMIT','TRUST_CASE',p_case_id::text,p_reason,jsonb_build_object('appealId',v_id));
  return v_id;
end $$;

create or replace function public.resolve_trust_review_case(p_case_id uuid,p_decision text,p_reason text,p_signal_status text default null,p_final_adverse_action boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_admin uuid:=public.assert_role(array['admin']); v_case public.trust_review_cases; v_level text; v_approval_count integer:=0;
begin
  select * into v_case from public.trust_review_cases where id=p_case_id for update;
  if v_case.id is null then raise exception 'TRUST_CASE_NOT_FOUND'; end if;
  if length(trim(coalesce(p_reason,'')))<10 then raise exception 'DECISION_REASON_TOO_SHORT'; end if;
  if upper(p_decision) not in ('NO_ABUSE','WARNING','LIMITED_RESTRICTION','HOLD_CONTINUE','SUSPEND','TERMINATE','COMPENSATE','RECOVER_LOSS','SHARED_RESPONSIBILITY') then raise exception 'TRUST_DECISION_INVALID'; end if;
  if p_final_adverse_action and upper(p_decision) not in ('SUSPEND','TERMINATE') then raise exception 'FINAL_ACTION_DECISION_INVALID'; end if;

  if p_final_adverse_action then
    insert into public.trust_case_decision_approvals(case_id,approver_id,approval_type,decision,reason)
    values(p_case_id,v_admin,'FINAL_ADVERSE',upper(p_decision),p_reason)
    on conflict(case_id,approver_id,approval_type,decision) do update set reason=excluded.reason,created_at=now();
    select count(distinct approver_id)::integer into v_approval_count from public.trust_case_decision_approvals
      where case_id=p_case_id and approval_type='FINAL_ADVERSE' and decision=upper(p_decision) and created_at>now()-interval '7 days';
    if v_approval_count<2 then
      update public.trust_review_cases set status='DECISION_PENDING',updated_at=now() where id=p_case_id;
      perform public.audit_event('TRUST_FINAL_ACTION_FIRST_APPROVAL','TRUST_CASE',p_case_id::text,p_reason,jsonb_build_object('decision',upper(p_decision),'approvalCount',v_approval_count));
      return jsonb_build_object('caseId',p_case_id,'decisionPending',true,'secondApprovalRequired',true,'approvalCount',v_approval_count,'requiredApprovalCount',2);
    end if;
  end if;

  update public.trust_review_cases set status=case when upper(p_decision)='NO_ABUSE' then 'DISMISSED' else 'RESOLVED' end,decision=upper(p_decision),decision_reason=p_reason,decided_by=v_admin,decided_at=now(),appeal_deadline=now()+interval '14 days',updated_at=now() where id=p_case_id;
  if p_signal_status is not null then
    if upper(p_signal_status) not in ('CONFIRMED','DISMISSED','EXPIRED') then raise exception 'SIGNAL_STATUS_INVALID'; end if;
    update public.trust_risk_signals set status=upper(p_signal_status),reviewed_by=v_admin,reviewed_at=now(),review_memo=p_reason where entity_type=v_case.subject_type and entity_id=v_case.subject_id and status='ACTIVE';
  end if;
  perform public.recalculate_entity_trust(v_case.subject_type,v_case.subject_id);
  if p_final_adverse_action then
    update public.entity_trust_profiles set final_adverse_action=true,final_action_reason=p_reason,last_manual_review_at=now(),risk_level='BLOCKED',updated_at=now() where entity_type=v_case.subject_type and entity_id=v_case.subject_id;
  else
    update public.entity_trust_profiles set last_manual_review_at=now(),updated_at=now() where entity_type=v_case.subject_type and entity_id=v_case.subject_id;
  end if;
  update public.trust_case_actions set status=case when upper(p_decision)='NO_ABUSE' then 'REVOKED' else status end where case_id=p_case_id and status='ACTIVE';
  perform public.audit_event('TRUST_CASE_RESOLVE','TRUST_CASE',p_case_id::text,p_reason,jsonb_build_object('decision',upper(p_decision),'finalAdverseAction',p_final_adverse_action,'approvalCount',v_approval_count));
  select risk_level into v_level from public.entity_trust_profiles where entity_type=v_case.subject_type and entity_id=v_case.subject_id;
  return jsonb_build_object('caseId',p_case_id,'decision',upper(p_decision),'riskLevel',v_level,'appealDeadline',now()+interval '14 days','secondApprovalRequired',false);
end $$;

create or replace function public.assess_checkout_risk(p_buyer_id uuid,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_profile public.entity_trust_profiles; v_orders integer; v_cases integer; v_reasons text[]:='{}'; v_decision text:='ALLOW';
begin
  select * into v_profile from public.entity_trust_profiles where entity_type='BUYER' and entity_id=p_buyer_id::text;
  select count(*)::integer into v_orders from public.orders where buyer_id=p_buyer_id and ordered_at>now()-interval '24 hours';
  select count(*)::integer into v_cases from public.trust_review_cases where subject_type='BUYER' and subject_id=p_buyer_id::text and status not in ('RESOLVED','DISMISSED','CLOSED');
  if coalesce(v_profile.final_adverse_action,false) then v_decision:='BLOCK'; v_reasons:=array_append(v_reasons,'CONFIRMED_ACCOUNT_RESTRICTION');
  elsif coalesce(v_profile.risk_level,'NORMAL') in ('HOLD','REVIEW') or v_cases>0 or v_orders>=8 then v_decision:='REVIEW';
    if coalesce(v_profile.risk_level,'NORMAL') in ('HOLD','REVIEW') then v_reasons:=array_append(v_reasons,'ACTIVE_RISK_REVIEW'); end if;
    if v_cases>0 then v_reasons:=array_append(v_reasons,'OPEN_TRUST_CASE'); end if;
    if v_orders>=8 then v_reasons:=array_append(v_reasons,'ORDER_VELOCITY'); end if;
  end if;
  return jsonb_build_object('decision',v_decision,'riskLevel',coalesce(v_profile.risk_level,'NORMAL'),'riskScore',coalesce(v_profile.risk_score,0),'reasons',v_reasons,'manualReviewRequired',v_decision='REVIEW');
end $$;

create or replace function public.assess_refund_risk(p_requester_id uuid,p_payment_id uuid,p_claim_id uuid,p_amount bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_profile public.entity_trust_profiles; v_refunds integer; v_claims integer; v_paid bigint; v_refunded bigint; v_reasons text[]:='{}'; v_decision text:='ALLOW';
begin
  select * into v_profile from public.entity_trust_profiles where entity_type='BUYER' and entity_id=p_requester_id::text;
  select count(*)::integer,coalesce(sum(amount),0)::bigint into v_refunds,v_refunded from public.refunds where payment_id=p_payment_id and status in ('DONE','PROCESSING');
  select coalesce(p.amount,0)::bigint into v_paid from public.payments p where p.id=p_payment_id;
  select count(*)::integer into v_claims from public.claims where requester_id=p_requester_id and created_at>now()-interval '90 days';
  if v_refunded>=v_paid or exists(select 1 from public.refund_request_reviews where payment_id=p_payment_id and coalesce(claim_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce(p_claim_id,'00000000-0000-0000-0000-000000000000'::uuid) and requested_amount=p_amount and status in ('PENDING','APPROVED','PAID')) then
    v_decision:='DUPLICATE_BLOCK'; v_reasons:=array_append(v_reasons,'DUPLICATE_OR_FULLY_REFUNDED');
  elsif coalesce(v_profile.risk_level,'NORMAL') in ('REVIEW','HOLD','BLOCKED') or v_claims>=5 then
    v_decision:='REVIEW';
    if coalesce(v_profile.risk_level,'NORMAL') in ('REVIEW','HOLD','BLOCKED') then v_reasons:=array_append(v_reasons,'ACTIVE_BUYER_RISK_REVIEW'); end if;
    if v_claims>=5 then v_reasons:=array_append(v_reasons,'HIGH_CLAIM_VELOCITY'); end if;
  end if;
  return jsonb_build_object('decision',v_decision,'reasons',v_reasons,'recentClaims',v_claims,'alreadyRefunded',v_refunded,'paidAmount',v_paid,'manualReviewRequired',v_decision='REVIEW');
end $$;

create or replace function public.assess_payout_risk(p_seller_id uuid,p_amount bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_profile public.entity_trust_profiles; v_actions integer; v_changes integer; v_reserves bigint; v_reasons text[]:='{}'; v_decision text:='ALLOW';
begin
  select * into v_profile from public.entity_trust_profiles where entity_type='SELLER' and entity_id=p_seller_id::text;
  select count(*)::integer into v_actions from public.trust_case_actions a join public.trust_review_cases c on c.id=a.case_id where c.subject_type='SELLER' and c.subject_id=p_seller_id::text and a.action_type in ('PAYOUT_HOLD','ACCOUNT_CHANGE_HOLD') and a.status='ACTIVE' and (a.ends_at is null or a.ends_at>now());
  select count(*)::integer into v_changes from public.account_security_events where seller_id=p_seller_id and event_type in ('SETTLEMENT_ACCOUNT_CHANGED','PAYOUT_DESTINATION_CHANGED') and created_at>now()-interval '72 hours';
  select coalesce(sum(amount),0)::bigint into v_reserves from public.settlement_reserves where seller_id=p_seller_id and status in ('HELD','PARTIALLY_RELEASED');
  if coalesce(v_profile.final_adverse_action,false) or v_actions>0 or v_changes>0 then v_decision:='HOLD';
    if coalesce(v_profile.final_adverse_action,false) then v_reasons:=array_append(v_reasons,'CONFIRMED_SELLER_RESTRICTION'); end if;
    if v_actions>0 then v_reasons:=array_append(v_reasons,'ACTIVE_PAYOUT_HOLD'); end if;
    if v_changes>0 then v_reasons:=array_append(v_reasons,'RECENT_ACCOUNT_CHANGE_COOLING_OFF'); end if;
  elsif coalesce(v_profile.risk_level,'NORMAL') in ('REVIEW','HOLD') or v_reserves>0 then v_decision:='REVIEW';
    if coalesce(v_profile.risk_level,'NORMAL') in ('REVIEW','HOLD') then v_reasons:=array_append(v_reasons,'SELLER_RISK_REVIEW'); end if;
    if v_reserves>0 then v_reasons:=array_append(v_reasons,'ACTIVE_SETTLEMENT_RESERVE'); end if;
  end if;
  return jsonb_build_object('decision',v_decision,'reasons',v_reasons,'riskLevel',coalesce(v_profile.risk_level,'NORMAL'),'riskScore',coalesce(v_profile.risk_score,0),'heldReserve',v_reserves,'requestedAmount',p_amount);
end $$;

create or replace function public.run_mutual_protection_controls()
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_expired_actions integer;
  v_expired_signals integer;
  v_overdue_notices integer;
  v_overdue_decisions integer;
  v_recalculated integer := 0;
  v_target record;
begin
  update public.trust_case_actions set status='EXPIRED' where status='ACTIVE' and ends_at is not null and ends_at<=now(); get diagnostics v_expired_actions=row_count;
  update public.trust_risk_signals set status='EXPIRED' where status='ACTIVE' and expires_at is not null and expires_at<=now(); get diagnostics v_expired_signals=row_count;
  update public.trust_review_cases set priority='HIGH',updated_at=now() where status not in ('RESOLVED','DISMISSED','CLOSED') and notice_sent_at is null and notice_due_at<now(); get diagnostics v_overdue_notices=row_count;
  update public.trust_review_cases set priority='CRITICAL',updated_at=now() where status not in ('RESOLVED','DISMISSED','CLOSED') and decision_due_at<now(); get diagnostics v_overdue_decisions=row_count;
  for v_target in select distinct entity_type,entity_id from public.trust_risk_signals where status in ('ACTIVE','CONFIRMED') and detected_at>now()-interval '365 days' loop
    perform public.recalculate_entity_trust(v_target.entity_type,v_target.entity_id);
    v_recalculated := v_recalculated + 1;
  end loop;
  return jsonb_build_object('expiredActions',v_expired_actions,'expiredSignals',v_expired_signals,'overdueNotices',v_overdue_notices,'overdueDecisions',v_overdue_decisions,'profilesRecalculated',v_recalculated,'ranAt',now());
end $$;

create or replace view public.admin_mutual_protection_dashboard as
select
  (select count(*) from public.trust_review_cases where status not in ('RESOLVED','DISMISSED','CLOSED')) as open_cases,
  (select count(*) from public.trust_review_cases where status not in ('RESOLVED','DISMISSED','CLOSED') and priority in ('HIGH','CRITICAL')) as urgent_cases,
  (select count(*) from public.entity_trust_profiles where entity_type='SELLER' and risk_level in ('REVIEW','HOLD','BLOCKED')) as seller_profiles_under_review,
  (select count(*) from public.entity_trust_profiles where entity_type='BUYER' and risk_level in ('REVIEW','HOLD','BLOCKED')) as buyer_profiles_under_review,
  (select count(*) from public.trust_case_actions where action_type in ('PAYOUT_HOLD','ACCOUNT_CHANGE_HOLD') and status='ACTIVE' and (ends_at is null or ends_at>now())) as active_payout_holds,
  (select count(*) from public.refund_request_reviews where status='PENDING') as pending_refund_reviews,
  (select count(*) from public.trust_appeals where status in ('RECEIVED','INVESTIGATING')) as pending_appeals,
  (select count(*) from public.trust_review_cases where status not in ('RESOLVED','DISMISSED','CLOSED') and decision_due_at<now()) as overdue_decisions,
  now() as checked_at;


create or replace view public.part48_mutual_protection_readiness as
with required_controls as (
  select count(*) filter (where status='VERIFIED') as verified_count, count(*) as required_count
  from public.operation_readiness
  where control_key in ('MUTUAL_ABUSE_REVIEW_STAFFING','REFUND_EVIDENCE_PROCESS','SELLER_PAYOUT_COOLING_OFF','DELIVERY_PROOF_INTEGRATION','RISK_MODEL_BIAS_REVIEW','TRUST_APPEAL_PROCESS')
), policy_count as (
  select count(*) as published_count from public.policy_publications where version='2026.08.06-v2' and policy_code in ('BUYER_TERMS','PRIVACY_POLICY','COMMERCE_POLICY','SELLER_TERMS','TRUST_SAFETY_POLICY')
)
select
  r.verified_count, r.required_count, p.published_count,
  (select count(*) from public.trust_risk_rules where enabled) as enabled_rule_count,
  (select count(*) from public.trust_review_cases where automatic_final_decision) as prohibited_automatic_final_case_count,
  (r.required_count=6 and r.verified_count=6 and p.published_count=5 and (select count(*) from public.trust_risk_rules where enabled)>=12 and (select count(*) from public.trust_review_cases where automatic_final_decision)=0) as release_ready,
  now() as checked_at
from required_controls r cross join policy_count p;
revoke all on public.part48_mutual_protection_readiness from anon,authenticated;

create or replace function public.log_settlement_account_security_event()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_case uuid;
begin
  if tg_op='UPDATE' and (new.account_number_encrypted is distinct from old.account_number_encrypted or new.bank_code is distinct from old.bank_code or new.account_holder is distinct from old.account_holder) then
    insert into public.account_security_events(actor_type,actor_id,seller_id,event_type,risk_level,old_value_hash,new_value_hash,cooling_off_until,confirmed_by_mfa,metadata)
    select 'SELLER',s.owner_id,new.seller_id,'SETTLEMENT_ACCOUNT_CHANGED','HIGH',encode(digest(coalesce(old.bank_code,'')||':'||coalesce(old.account_number_last4,''),'sha256'),'hex'),encode(digest(coalesce(new.bank_code,'')||':'||coalesce(new.account_number_last4,''),'sha256'),'hex'),now()+interval '72 hours',false,jsonb_build_object('accountId',new.id) from public.sellers s where s.id=new.seller_id;
    perform public.record_trust_risk_signal('SELLER_PAYOUT_ACCOUNT_CHANGE','SELLER',new.seller_id::text,'SETTLEMENT_ACCOUNT_TRIGGER',jsonb_build_object('accountId',new.id),null,null,'ACCOUNT_CHANGE:'||new.id::text||':'||extract(epoch from new.updated_at)::bigint,null);
    v_case:=public.open_trust_review_case('SELLER',new.seller_id::text,'ACCOUNT_TAKEOVER','정산계좌가 변경되어 72시간 지급 냉각기간과 재검증이 적용됩니다.',jsonb_build_object('accountId',new.id),'HIGH','ACCOUNT_CHANGE_HOLD',72,true);
  end if;
  return new;
end $$;

drop trigger if exists trg_settlement_account_security_event on public.seller_settlement_accounts;
create trigger trg_settlement_account_security_event after update on public.seller_settlement_accounts for each row execute function public.log_settlement_account_security_event();

create or replace function public.prevent_evidence_mutation()
returns trigger language plpgsql as $$ begin raise exception 'TRUST_EVIDENCE_IMMUTABLE'; end $$;
drop trigger if exists trg_trust_case_evidence_immutable on public.trust_case_evidence;
create trigger trg_trust_case_evidence_immutable before update or delete on public.trust_case_evidence for each row execute function public.prevent_evidence_mutation();

alter table public.trust_risk_rules enable row level security;
alter table public.entity_trust_profiles enable row level security;
alter table public.trust_risk_signals enable row level security;
alter table public.trust_review_cases enable row level security;
alter table public.trust_case_evidence enable row level security;
alter table public.trust_case_actions enable row level security;
alter table public.trust_appeals enable row level security;
alter table public.trust_case_decision_approvals enable row level security;
alter table public.delivery_evidence_records enable row level security;
alter table public.return_inspections enable row level security;
alter table public.account_security_events enable row level security;
alter table public.refund_request_reviews enable row level security;

revoke all on public.trust_risk_rules,public.entity_trust_profiles,public.trust_risk_signals,public.trust_review_cases,public.trust_case_evidence,public.trust_case_actions,public.trust_appeals,public.trust_case_decision_approvals,public.delivery_evidence_records,public.return_inspections,public.account_security_events,public.refund_request_reviews from anon,authenticated;
revoke all on public.admin_mutual_protection_dashboard from anon,authenticated;

revoke execute on function public.recalculate_entity_trust(text,text),public.record_trust_risk_signal(text,text,text,text,jsonb,uuid,uuid,text,integer),public.open_trust_review_case(text,text,text,text,jsonb,text,text,integer,boolean),public.resolve_trust_review_case(uuid,text,text,text,boolean),public.assess_checkout_risk(uuid,jsonb),public.assess_refund_risk(uuid,uuid,uuid,bigint),public.assess_payout_risk(uuid,bigint),public.run_mutual_protection_controls() from public,anon,authenticated;
revoke execute on function public.submit_trust_appeal(uuid,text,jsonb) from public,anon;
grant execute on function public.submit_trust_appeal(uuid,text,jsonb) to authenticated;
grant execute on function public.recalculate_entity_trust(text,text),public.record_trust_risk_signal(text,text,text,text,jsonb,uuid,uuid,text,integer),public.open_trust_review_case(text,text,text,text,jsonb,text,text,integer,boolean),public.resolve_trust_review_case(uuid,text,text,text,boolean),public.assess_checkout_risk(uuid,jsonb),public.assess_refund_risk(uuid,uuid,uuid,bigint),public.assess_payout_risk(uuid,bigint),public.run_mutual_protection_controls() to service_role;

insert into public.operation_readiness(control_key,category,required_for_live,status,notes) values
('MUTUAL_ABUSE_REVIEW_STAFFING','TRUST_SAFETY',true,'NOT_VERIFIED','구매자·판매자 부정행위 신고, 임시조치, 수동심사, 이의제기 담당자 지정'),
('REFUND_EVIDENCE_PROCESS','TRUST_SAFETY',true,'NOT_VERIFIED','신선식품 사진·포장·송장·회수·검수 증거 절차와 과도하지 않은 증빙기준 검토'),
('SELLER_PAYOUT_COOLING_OFF','TRUST_SAFETY',true,'NOT_VERIFIED','정산계좌 변경 72시간 지급보류, MFA 및 예금주 재검증'),
('DELIVERY_PROOF_INTEGRATION','TRUST_SAFETY',true,'NOT_VERIFIED','택배사 스캔·배송완료·중량·온도기록 연동 및 개인정보 최소화'),
('RISK_MODEL_BIAS_REVIEW','TRUST_SAFETY',true,'NOT_VERIFIED','위험점수 오탐·차별·과도한 제한 점검, 자동 최종결정 금지'),
('TRUST_APPEAL_PROCESS','TRUST_SAFETY',true,'NOT_VERIFIED','불이익 통지, 사유 제공, 14일 이의제기와 독립 재심 절차')
on conflict(control_key) do nothing;

-- Part 48 공개 정책 v2 원문 해시. 동의증거는 이 버전·해시를 함께 저장합니다.
insert into public.policy_publications(policy_code,version,content_hash,effective_at,content_url) values
('BUYER_TERMS','2026.08.06-v2','948c3fa2e5a7e29f8bad8401f43658c93374cd507666ae7164e0daa6c4286ffd','2026-08-06T00:00:00+09:00','/policies/terms.html'),
('PRIVACY_POLICY','2026.08.06-v2','86fbb57f946f95e1da4993540882a474760d8775ce5d46d5413c1dc19b0788b6','2026-08-06T00:00:00+09:00','/policies/privacy.html'),
('COMMERCE_POLICY','2026.08.06-v2','3d7ca34c8f5a014aabd7510c2f0497963b5ab9e106b1420fdd4f526527ab212f','2026-08-06T00:00:00+09:00','/policies/commerce.html'),
('SELLER_TERMS','2026.08.06-v2','ebae977e7af8119d218ce657bd4f2cb8eee9af1066c17fd6c81de4d811b56d97','2026-08-06T00:00:00+09:00','/policies/seller.html'),
('TRUST_SAFETY_POLICY','2026.08.06-v2','354f922ea40f7518d6688a70d7f697039c57376d500ac0d7f5e678b0ae9cb141','2026-08-06T00:00:00+09:00','/policies/trust-safety.html')
on conflict(policy_code,version) do update set content_hash=excluded.content_hash,effective_at=excluded.effective_at,content_url=excluded.content_url;

commit;
