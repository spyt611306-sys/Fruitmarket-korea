select * from public.part48_mutual_protection_readiness;
select control_key,status,notes from public.operation_readiness where category='TRUST_SAFETY' order by control_key;
select rule_code,actor_scope,severity,default_points,final_action_requires_manual_review from public.trust_risk_rules where active order by actor_scope,rule_code;
select * from public.admin_mutual_protection_dashboard;
