-- Part 46: 운영 게이트, 분쟁 SLA, 판매자 성과, 리콜·개인정보·정산 통제 시드
begin;

insert into public.operation_readiness(control_key,category,required_for_live,status,notes) values
('LEGAL_INTERMEDIARY_NOTICE_APPROVED','LEGAL',true,'NOT_VERIFIED','통신판매중개 고지 법률 검토 및 운영 도메인 반영'),
('LEGAL_SELLER_TERMS_APPROVED','LEGAL',true,'NOT_VERIFIED','판매자 이용약관·수수료·정산·제재 조항 검토'),
('LEGAL_BUYER_TERMS_APPROVED','LEGAL',true,'NOT_VERIFIED','구매자 약관·청약철회·분쟁기준 검토'),
('PRIVACY_INTERNAL_PLAN','PRIVACY',true,'NOT_VERIFIED','개인정보 내부관리계획·접근권한·접속기록·유출대응'),
('PAYMENT_PG_ESCROW_ACTIVE','PAYMENT',true,'NOT_VERIFIED','PG·구매안전서비스·환불·웹훅 대사 확인'),
('PAYOUT_PROVIDER_ACTIVE','SETTLEMENT',true,'NOT_VERIFIED','플랫폼 직접 자금보관 없이 계약된 지급대행 사용'),
('SELLER_IDENTITY_VERIFICATION','SELLER',true,'NOT_VERIFIED','사업자·대표자·통신판매업·정산계좌 확인'),
('FRUIT_LOT_TRACEABILITY','FOOD_SAFETY',true,'NOT_VERIFIED','로트·수확·포장·원산지·검사증빙 추적'),
('RECALL_DRILL_COMPLETED','FOOD_SAFETY',true,'NOT_VERIFIED','리콜 차단·구매자 통지·회수 모의훈련'),
('DISPUTE_SLA_STAFFING','CUSTOMER_SUPPORT',true,'NOT_VERIFIED','3영업일 경과안내·10영업일 처리방안 운영인력'),
('BACKUP_RESTORE_DRILL','SECURITY',true,'NOT_VERIFIED','백업·복구·장애대응 훈련'),
('MOBILE_DESKTOP_UX_AUDIT','UX',true,'NOT_VERIFIED','320~1920px 및 키보드·스크린리더 점검')
on conflict(control_key) do nothing;

create or replace function public.run_part46_operational_controls()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_dispute_first integer;
  v_dispute_resolution integer;
  v_expired_evidence integer;
  v_expired_lots integer;
  v_result jsonb;
begin
  update public.dispute_cases set priority='HIGH',updated_at=now()
    where status not in ('RESOLVED','REJECTED','CLOSED') and first_response_at is null and first_response_due_at < now();
  get diagnostics v_dispute_first = row_count;
  update public.dispute_cases set priority='CRITICAL',updated_at=now()
    where status not in ('RESOLVED','REJECTED','CLOSED') and resolution_due_at < now();
  get diagnostics v_dispute_resolution = row_count;
  update public.product_quality_evidence set status='EXPIRED'
    where status='VERIFIED' and expires_at is not null and expires_at < current_date;
  get diagnostics v_expired_evidence = row_count;
  update public.inventory_lots set active=false,qc_status='BLOCKED',updated_at=now()
    where active=true and recommended_consume_by is not null and recommended_consume_by < current_date;
  get diagnostics v_expired_lots = row_count;
  v_result := jsonb_build_object(
    'overdueFirstResponse',v_dispute_first,
    'overdueResolution',v_dispute_resolution,
    'expiredEvidence',v_expired_evidence,
    'expiredLots',v_expired_lots,
    'ranAt',now()
  );
  insert into public.scheduled_job_runs(job_name,run_key,status,result,started_at,completed_at)
  values('PART46_OPERATIONAL_CONTROLS','PART46:'||to_char(now(),'YYYYMMDDHH24MISSMS'),'SUCCEEDED',v_result,now(),now());
  return v_result;
end;
$$;

create or replace view public.admin_marketplace_compliance_dashboard as
select
  (select count(*) from public.products where active and compliance_status not in ('READY','APPROVED')) as products_compliance_incomplete,
  (select count(*) from public.inventory_lots where active and (qc_status not in ('PASSED','CONDITIONAL') or recall_status<>'NORMAL')) as blocked_or_unverified_lots,
  (select count(*) from public.dispute_cases where status not in ('RESOLVED','REJECTED','CLOSED') and first_response_due_at<now()) as overdue_first_responses,
  (select count(*) from public.dispute_cases where status not in ('RESOLVED','REJECTED','CLOSED') and resolution_due_at<now()) as overdue_resolutions,
  (select count(*) from public.recall_cases where status in ('OPEN','NOTIFYING','COLLECTING')) as active_recalls,
  (select count(*) from public.sellers where approval_status='APPROVED' and (business_status<>'VERIFIED' or contract_accepted_at is null)) as seller_verification_gaps,
  (select count(*) from public.operation_readiness where required_for_live and status<>'VERIFIED') as live_gate_failures,
  now() as checked_at;

revoke all on public.admin_marketplace_compliance_dashboard from anon,authenticated;


create or replace function public.enforce_marketplace_product_live_gate()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_seller public.sellers;
  v_fresh public.product_fresh_profiles;
  v_transition_to_live boolean;
begin
  v_transition_to_live := (tg_op='INSERT' or new.sale_status is distinct from old.sale_status or new.approval_status is distinct from old.approval_status)
    and (new.sale_status in ('ON_SALE','SOLD_OUT') or new.approval_status='APPROVED');
  if not v_transition_to_live then return new; end if;

  select * into v_seller from public.sellers where id=new.seller_id;
  if v_seller.id is null or v_seller.approval_status<>'APPROVED' or v_seller.status<>'ACTIVE' then
    raise exception 'SELLER_NOT_ACTIVE_OR_APPROVED';
  end if;
  if coalesce(v_seller.business_status,'UNVERIFIED')<>'VERIFIED' then raise exception 'SELLER_BUSINESS_NOT_VERIFIED'; end if;
  if v_seller.contract_accepted_at is null or coalesce(v_seller.contract_version,'')='' then raise exception 'SELLER_CONTRACT_NOT_ACCEPTED'; end if;
  if not exists(select 1 from public.marketplace_disclosures where code='INTERMEDIARY_NOTICE' and active and legal_review_status='APPROVED' and effective_from<=now() and (effective_to is null or effective_to>now())) then
    raise exception 'INTERMEDIARY_NOTICE_NOT_APPROVED';
  end if;
  if coalesce(new.origin,'')='' then raise exception 'PRODUCT_ORIGIN_REQUIRED'; end if;
  if coalesce(new.product_info_notice,'{}'::jsonb)='{}'::jsonb then raise exception 'PRODUCT_INFO_NOTICE_REQUIRED'; end if;
  if coalesce(new.return_policy_snapshot,'{}'::jsonb)='{}'::jsonb then raise exception 'RETURN_POLICY_REQUIRED'; end if;
  if not coalesce(new.prohibited_claim_check,false) then raise exception 'PROHIBITED_CLAIM_CHECK_REQUIRED'; end if;

  select * into v_fresh from public.product_fresh_profiles where product_id=new.id;
  if v_fresh.product_id is null or v_fresh.compliance_status<>'APPROVED' then raise exception 'FRESH_PROFILE_APPROVAL_REQUIRED'; end if;
  if coalesce(new.compliance_status,'INCOMPLETE') not in ('READY','APPROVED') then raise exception 'PRODUCT_COMPLIANCE_NOT_READY'; end if;

  new.seller_disclosure_snapshot := jsonb_build_object(
    'sellerId',v_seller.id,'storeName',v_seller.store_name,'legalName',v_seller.legal_name,
    'businessNumber',v_seller.business_number,
    'mailOrderReportNumber',v_seller.mail_order_report_number,'businessAddress',v_seller.business_address,
    'customerServicePhone',v_seller.customer_service_phone,'customerServiceEmail',v_seller.customer_service_email,
    'capturedAt',now()
  );
  return new;
end;
$$;

drop trigger if exists trg_enforce_marketplace_product_live_gate on public.products;
create trigger trg_enforce_marketplace_product_live_gate
before insert or update on public.products
for each row execute function public.enforce_marketplace_product_live_gate();

create or replace function public.accept_current_seller_contract(p_contract_version text, p_ip_hash text default null, p_user_agent_hash text default null, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user uuid := public.assert_role(array['seller','admin']);
  v_seller uuid := public.current_seller_id();
  v_contract public.seller_contract_versions;
begin
  select * into v_contract from public.seller_contract_versions
   where version=p_contract_version and active and legal_review_status='APPROVED'
     and effective_from is not null and effective_from<=now()
   limit 1;
  if v_contract.id is null then raise exception 'SELLER_CONTRACT_NOT_ACTIVE_OR_APPROVED'; end if;
  insert into public.seller_contract_acceptances(seller_id,contract_version_id,accepted_by,ip_hash,user_agent_hash,acceptance_evidence)
  values(v_seller,v_contract.id,v_user,p_ip_hash,p_user_agent_hash,coalesce(p_evidence,'{}'::jsonb))
  on conflict(seller_id,contract_version_id) do update set accepted_at=now(),accepted_by=excluded.accepted_by,ip_hash=excluded.ip_hash,user_agent_hash=excluded.user_agent_hash,acceptance_evidence=excluded.acceptance_evidence;
  update public.sellers set contract_version=v_contract.version,contract_accepted_at=now(),updated_at=now() where id=v_seller;
  perform public.audit_event('SELLER_CONTRACT_ACCEPT','SELLER',v_seller::text,v_contract.version,jsonb_build_object('contractVersionId',v_contract.id));
  return jsonb_build_object('sellerId',v_seller,'version',v_contract.version,'acceptedAt',now());
end;
$$;

create or replace function public.review_fresh_product(p_product_id uuid,p_approve boolean,p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_admin uuid := public.assert_role(array['admin']);
  v_target text := case when p_approve then 'APPROVED' else 'REJECTED' end;
  v_result jsonb;
begin
  if not p_approve and length(trim(coalesce(p_reason,'')))<2 then raise exception 'REJECTION_REASON_REQUIRED'; end if;
  if p_approve then
    select public.evaluate_fresh_product_compliance(p_product_id) into v_result;
    if v_result->>'status'<>'READY' then raise exception 'FRESH_PRODUCT_COMPLIANCE_INCOMPLETE:%',v_result::text; end if;
  end if;
  update public.product_fresh_profiles set compliance_status=v_target,approved_by=case when p_approve then v_admin else null end,approved_at=case when p_approve then now() else null end,updated_at=now()
   where product_id=p_product_id;
  if not found then raise exception 'FRESH_PROFILE_NOT_FOUND'; end if;
  update public.products set compliance_status=case when p_approve then 'READY' else 'INCOMPLETE' end,
    compliance_reviewed_by=v_admin,compliance_reviewed_at=now(),updated_at=now() where id=p_product_id;
  perform public.audit_event('FRESH_PRODUCT_REVIEW','PRODUCT',p_product_id::text,p_reason,jsonb_build_object('approved',p_approve));
  return jsonb_build_object('productId',p_product_id,'freshStatus',v_target,'approved',p_approve);
end;
$$;

revoke execute on function public.accept_current_seller_contract(text,text,text,jsonb), public.review_fresh_product(uuid,boolean,text) from public,anon;
grant execute on function public.accept_current_seller_contract(text,text,text,jsonb), public.review_fresh_product(uuid,boolean,text) to authenticated;

grant execute on function public.run_part46_operational_controls() to service_role;

commit;
