-- 푸릇마켓 관리자 부트스트랩 후 안전 점검
-- 읽기 전용 검사입니다. 데이터 변경 없음.

-- 1) Auth 사용자와 profiles 관리자 연결 확인
select
  u.id as admin_uuid,
  u.email,
  u.email_confirmed_at,
  p.display_name,
  p.role,
  p.status,
  p.updated_at
from auth.users u
left join public.profiles p on p.id = u.id
where lower(u.email) = lower('pdg04036@naver.com');

-- 2) 권한 보호 트리거가 다시 활성화됐는지 확인
select
  t.tgname as trigger_name,
  case t.tgenabled
    when 'O' then 'ENABLED'
    when 'D' then 'DISABLED'
    when 'R' then 'REPLICA'
    when 'A' then 'ALWAYS'
    else t.tgenabled::text
  end as trigger_status
from pg_trigger t
where t.tgrelid = 'public.profiles'::regclass
  and t.tgname = 'profiles_privilege_guard'
  and not t.tgisinternal;

-- 3) Part 48 핵심 설치상태 확인
select
  to_regclass('public.orders') as orders_table,
  to_regclass('public.payments') as payments_table,
  to_regclass('public.trust_risk_rules') as trust_risk_rules_table,
  to_regclass('public.trust_review_cases') as trust_review_cases_table,
  to_regclass('public.operation_readiness') as operation_readiness_table;

-- 4) 위험규칙 활성화 개수
select
  count(*) as total_rules,
  count(*) filter (where active) as active_rules
from public.trust_risk_rules;

-- 5) 실제 운영검증 6개 상태
select
  control_key,
  status,
  notes,
  verified_by,
  verified_at,
  expires_at
from public.operation_readiness
where control_key in (
  'MUTUAL_ABUSE_REVIEW_STAFFING',
  'REFUND_EVIDENCE_PROCESS',
  'SELLER_PAYOUT_COOLING_OFF',
  'DELIVERY_PROOF_INTEGRATION',
  'RISK_MODEL_BIAS_REVIEW',
  'TRUST_APPEAL_PROCESS'
)
order by control_key;

-- 6) 최종 준비상태
select *
from public.part48_mutual_protection_readiness;
