-- Part 48 상호 부정행위 보호 구조 검증. SQL 19 실행 후 사용합니다.
do $$
declare t text; f text;
begin
  foreach t in array array['trust_risk_rules','entity_trust_profiles','trust_risk_signals','trust_review_cases','trust_case_evidence','trust_case_actions','trust_appeals','trust_case_decision_approvals','delivery_evidence_records','return_inspections','account_security_events','refund_request_reviews'] loop
    if to_regclass('public.'||t) is null then raise exception 'PART48_TABLE_MISSING:%',t; end if;
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=t and c.relrowsecurity) then raise exception 'PART48_RLS_MISSING:%',t; end if;
  end loop;
  foreach f in array array['record_trust_risk_signal','open_trust_review_case','submit_trust_appeal','resolve_trust_review_case','assess_checkout_risk','assess_refund_risk','assess_payout_risk','run_mutual_protection_controls'] loop
    if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=f) then raise exception 'PART48_FUNCTION_MISSING:%',f; end if;
  end loop;
  if exists(select 1 from public.trust_review_cases where automatic_final_decision) then raise exception 'PART48_AUTOMATIC_FINAL_DECISION_PROHIBITED'; end if;
  if (select count(*) from public.trust_risk_rules where enabled)<12 then raise exception 'PART48_RISK_RULE_SEED_INCOMPLETE'; end if;
  if (select count(*) from public.policy_publications where version='2026.08.06-v2' and content_hash<>'REPLACE_WITH_BUILD_HASH')<5 then raise exception 'PART48_POLICY_HASH_INCOMPLETE'; end if;
end $$;

select * from public.part48_mutual_protection_readiness;
select control_key,status,notes from public.operation_readiness where category='TRUST_SAFETY' order by control_key;
select rule_code,subject_type,severity,default_points,final_action_requires_manual_review from public.trust_risk_rules order by subject_type,rule_code;
select * from public.admin_mutual_protection_dashboard;
