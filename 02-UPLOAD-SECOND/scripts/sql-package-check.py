from __future__ import annotations
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SQL=ROOT/'supabase/sql'
ordered=[
 '01_schema.sql','02_functions_triggers.sql','03_rls_policies.sql','04_storage_policies.sql',
 '05_seed_public_data.sql','07_commercial_hardening.sql','09_full_marketplace_schema.sql',
 '10_full_marketplace_rpcs.sql','12_full_marketplace_operations.sql','11_full_marketplace_rls.sql',
 '06_make_admin_template.sql','08_verification_queries.sql','13_full_verification.sql',
 '14_marketplace_legal_compliance.sql','15_fruit_specialization.sql','16_marketplace_operations_controls.sql','17_part46_verification.sql',
 '18_policy_evidence_and_legal_holds.sql','19_mutual_fraud_and_abuse_protection.sql','20_part48_verification.sql'
]
issues=[]
content={}
for name in ordered:
    p=SQL/name
    if not p.exists(): issues.append(f'누락:{name}')
    else: content[name]=p.read_text('utf-8')
all_sql='\n'.join(content.values())
base_schema='\n'.join(content.get(x,'') for x in ['01_schema.sql','09_full_marketplace_schema.sql','12_full_marketplace_operations.sql','14_marketplace_legal_compliance.sql','15_fruit_specialization.sql','18_policy_evidence_and_legal_holds.sql','19_mutual_fraud_and_abuse_protection.sql','20_part48_verification.sql'])
all_tables=sorted(set(re.findall(r'create table if not exists public\.([a-z0-9_]+)',base_schema,re.I)))
rls=content.get('03_rls_policies.sql','')+'\n'+content.get('11_full_marketplace_rls.sql','')+'\n'+content.get('14_marketplace_legal_compliance.sql','')+'\n'+content.get('15_fruit_specialization.sql','')+'\n'+content.get('18_policy_evidence_and_legal_holds.sql','')+'\n'+content.get('19_mutual_fraud_and_abuse_protection.sql','')
# Tables enabled literally or listed in the dynamic FOREACH arrays.
rls_tables=set(re.findall(r'alter table public\.([a-z0-9_]+) enable row level security',rls,re.I))
for array in re.findall(r'FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[(.*?)\]\s+LOOP',rls,re.I|re.S):
    rls_tables.update(re.findall(r"'([a-z0-9_]+)'",array,re.I))
for table in all_tables:
    if table not in rls_tables: issues.append(f'RLS 누락:{table}')

hard=content.get('07_commercial_hardening.sql','')
seed=content.get('05_seed_public_data.sql','')
storage=content.get('04_storage_policies.sql','')
rpcs=content.get('10_full_marketplace_rpcs.sql','')
ops=content.get('12_full_marketplace_operations.sql','')
rls2=content.get('11_full_marketplace_rls.sql','')
verify=content.get('13_full_verification.sql','')
run_order=(SQL/'00_RUN_ORDER.md').read_text('utf-8') if (SQL/'00_RUN_ORDER.md').exists() else ''
protection=content.get('19_mutual_fraud_and_abuse_protection.sql','')

checks={
 'ordersDirectWriteRevoked':'revoke insert, update, delete on public.orders from authenticated;' in hard,
 'profilePrivilegeGuard':'PROFILE_PRIVILEGE_CHANGE_FORBIDDEN' in hard,
 'sellerApprovalGuard':'SELLER_APPROVAL_CHANGE_FORBIDDEN' in hard,
 'productSellerGuard':'PRODUCT_SELLER_CHANGE_FORBIDDEN' in hard,
 'checkoutTransaction':'create or replace function public.prepare_checkout' in rpcs and 'for update' in rpcs,
 'inventoryReservation':'inventory_reservations' in rpcs and 'expire_stale_reservations' in rpcs,
 'paymentFinalize':'create or replace function public.finalize_payment' in rpcs,
 'refundLedger':'create or replace function public.apply_payment_refund' in ops and 'refund_items' in ops,
 'payoutDualApproval':'SETTLEMENT_NOT_DUAL_APPROVED' in ops and 'request_settlement_payout' in ops,
 'scheduledJobs':'run_marketplace_scheduled_jobs' in ops and 'scheduled_job_runs' in ops,
 'providerReconciliation':'create or replace function public.reconcile_provider_payment' in ops,
 'consentReceipts':'consent_receipts' in content.get('09_full_marketplace_schema.sql','') and 'consentReceipts' in content.get('09_full_marketplace_schema.sql',''),
 'adminPolicyIdempotent':"DROP POLICY IF EXISTS %I ON public.%I" in rls2,
 'verificationSql':'required_tables' in verify and 'required_functions' in verify,
 'noAmbiguousRoleVariable':not re.search(r'select\s+role\s+into\s+role\b',all_sql,re.I),
 'noPublicUnitNumber':'606호' not in all_sql,
 'bannerSeedThree':len(re.findall(r'home-hero-0[123]\.webp',seed))==3,
 'part46BusinessDaySla':'add_business_days' in content.get('14_marketplace_legal_compliance.sql','') and 'public.add_business_days(now(), 3)' in content.get('14_marketplace_legal_compliance.sql',''),
 'part46DisputeLedger':'dispute_cases' in content.get('14_marketplace_legal_compliance.sql','') and 'dispute_events' in content.get('14_marketplace_legal_compliance.sql',''),
 'part46FruitLots':'inventory_lots' in content.get('15_fruit_specialization.sql','') and 'reserve_inventory_lots_fefo' in content.get('15_fruit_specialization.sql',''),
 'part46Recall':'recall_cases' in content.get('15_fruit_specialization.sql','') and 'block_recalled_lot' in content.get('15_fruit_specialization.sql',''),
 'part46OperationalGate':'run_part46_operational_controls' in content.get('16_marketplace_operations_controls.sql',''),
 'part46Verification':'part46_live_release_ready' in content.get('17_part46_verification.sql',''),
 'part48RiskRules':'trust_risk_rules' in protection and 'SELLER_FALSE_TRACKING' in protection and 'BUYER_DUPLICATE_REFUND' in protection,
 'part48ManualReview':'final_action_requires_manual_review' in protection and 'automatic_final_decision boolean not null default false' in protection,
 'part48EvidenceImmutable':'TRUST_EVIDENCE_IMMUTABLE' in protection and 'prevent_evidence_mutation' in protection,
 'part48Appeals':'trust_appeals' in protection and 'submit_trust_appeal' in protection,
 'part48AccountCooling':"interval '72 hours'" in protection and 'SETTLEMENT_ACCOUNT_CHANGED' in protection,
 'part48PolicyHashes':'TRUST_SAFETY_POLICY' in protection and 'REPLACE_WITH_BUILD_HASH' not in protection,
 'part48ReadinessView':'part48_mutual_protection_readiness' in protection,
 'part48VerificationFile':'PART48_AUTOMATIC_FINAL_DECISION_PROHIBITED' in content.get('20_part48_verification.sql',''),
}
for key,ok in checks.items():
    if not ok: issues.append(f'검사 실패:{key}')
for bucket in ['public-assets','product-images','seller-documents','claim-evidence']:
    if bucket not in storage: issues.append(f'Storage 정책 누락:{bucket}')
for fn in ['prepare_checkout','finalize_payment','apply_payment_refund','request_settlement_payout','complete_payout','run_marketplace_scheduled_jobs','reconcile_provider_payment','approve_seller_application','transition_shipment','transition_claim']:
    if not re.search(rf'create or replace function public\.{re.escape(fn)}\b',all_sql,re.I): issues.append(f'RPC 누락:{fn}')
for name in ['09_full_marketplace_schema.sql','10_full_marketplace_rpcs.sql','12_full_marketplace_operations.sql','11_full_marketplace_rls.sql','13_full_verification.sql','14_marketplace_legal_compliance.sql','15_fruit_specialization.sql','16_marketplace_operations_controls.sql','17_part46_verification.sql','18_policy_evidence_and_legal_holds.sql','19_mutual_fraud_and_abuse_protection.sql','20_part48_verification.sql']:
    if name not in run_order: issues.append(f'실행순서 문서 누락:{name}')
# Dollar quotes and transaction blocks are coarse static guards.
for name,text in content.items():
    if text.count('$$')%2: issues.append(f'달러쿼트 불균형:{name}')

result={
 'checkedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
 'sqlFiles':ordered,'tableCount':len(all_tables),'rlsEnabledCount':len(rls_tables.intersection(all_tables)),
 'checks':checks,'issues':issues,'passed':not issues
}
(ROOT/'tests/sql-package-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result['passed'] else 1)
