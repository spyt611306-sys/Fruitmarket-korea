-- Part 46 설치·운영 준비 검증 쿼리
-- 읽기 전용. 결과를 모두 저장하고 라이브 전환 승인 근거로 사용합니다.

with required_tables(name) as (
  values
  ('marketplace_disclosures'),('seller_contract_versions'),('seller_contract_acceptances'),
  ('dispute_cases'),('dispute_events'),('legal_holds'),('record_retention_policies'),
  ('seller_performance_daily'),('seller_sanctions'),('settlement_reserves'),
  ('settlement_adjustments'),('settlement_reconciliations'),('tax_documents'),
  ('operator_action_evidence'),('product_fresh_profiles'),('product_quality_evidence'),
  ('inventory_lots'),('order_item_lot_allocations'),('quality_inspections'),
  ('cold_chain_events'),('recall_cases'),('recall_lots'),('recall_notifications'),
  ('delivery_calendars'),('weather_shipping_holds'),('fruit_quality_standards')
)
select name, to_regclass('public.'||name) is not null as installed
from required_tables order by name;

select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in (
  'marketplace_disclosures','seller_contract_versions','seller_contract_acceptances','dispute_cases','dispute_events',
  'legal_holds','record_retention_policies','seller_performance_daily','seller_sanctions','settlement_reserves',
  'settlement_adjustments','settlement_reconciliations','tax_documents','operator_action_evidence','product_fresh_profiles',
  'product_quality_evidence','inventory_lots','order_item_lot_allocations','quality_inspections','cold_chain_events',
  'recall_cases','recall_lots','recall_notifications','delivery_calendars','weather_shipping_holds','fruit_quality_standards'
) order by c.relname;

select routine_name
from information_schema.routines
where routine_schema='public' and routine_name in (
  'add_business_days','open_dispute_case','transition_dispute_case','evaluate_fresh_product_compliance',
  'reserve_inventory_lots_fefo','run_part46_operational_controls','enforce_marketplace_product_live_gate',
  'accept_current_seller_contract','review_fresh_product'
) order by routine_name;

select * from public.admin_marketplace_compliance_dashboard;
select control_key,category,status,required_for_live,verified_at,expires_at,notes
from public.operation_readiness order by category,control_key;

select code,version,legal_review_status,active,effective_from,effective_to
from public.marketplace_disclosures order by code;

select id,store_name,approval_status,status,business_status,contract_version,contract_accepted_at,risk_hold
from public.sellers
where approval_status='APPROVED' and (
  status<>'ACTIVE' or business_status<>'VERIFIED' or contract_accepted_at is null or risk_hold
) order by store_name;

select id,name,seller_id,approval_status,sale_status,compliance_status,compliance_flags,
       prohibited_claim_check,
       product_info_notice<>'{}'::jsonb as has_product_notice,
       return_policy_snapshot<>'{}'::jsonb as has_return_policy
from public.products
where sale_status in ('ON_SALE','SOLD_OUT') and (
  approval_status<>'APPROVED' or compliance_status not in ('READY','APPROVED')
  or not prohibited_claim_check or product_info_notice='{}'::jsonb or return_policy_snapshot='{}'::jsonb
) order by updated_at desc;

select id,product_id,lot_code,qc_status,recall_status,recommended_consume_by,active
from public.inventory_lots
where active and (
  qc_status not in ('PASSED','CONDITIONAL') or recall_status<>'NORMAL'
  or (recommended_consume_by is not null and recommended_consume_by<current_date)
) order by recommended_consume_by nulls last;

select id,case_number,status,priority,first_response_due_at,resolution_due_at
from public.dispute_cases
where status not in ('RESOLVED','REJECTED','CLOSED')
  and (first_response_due_at<now() or resolution_due_at<now())
order by priority desc,created_at;

select
  not exists(select 1 from public.operation_readiness where required_for_live and status<>'VERIFIED')
  and exists(select 1 from public.marketplace_disclosures where code='INTERMEDIARY_NOTICE' and active and legal_review_status='APPROVED')
  and not exists(select 1 from public.sellers where approval_status='APPROVED' and (status<>'ACTIVE' or business_status<>'VERIFIED' or contract_accepted_at is null or risk_hold))
  and not exists(select 1 from public.products where sale_status in ('ON_SALE','SOLD_OUT') and (approval_status<>'APPROVED' or compliance_status not in ('READY','APPROVED') or not prohibited_claim_check))
  as part46_live_release_ready;
