# 푸릇마켓 Part 48 SQL 실행 순서

Supabase Dashboard → **SQL Editor → New query**에서 아래 순서대로 파일 하나씩 실행합니다.

1. `01_schema.sql`
2. `02_functions_triggers.sql`
3. `03_rls_policies.sql`
4. Dashboard → Storage에서 버킷 4개 생성
5. `04_storage_policies.sql`
6. `05_seed_public_data.sql`
7. `07_commercial_hardening.sql`
8. `09_full_marketplace_schema.sql`
9. `10_full_marketplace_rpcs.sql`
10. `12_full_marketplace_operations.sql`
11. `11_full_marketplace_rls.sql`
12. Authentication에서 관리자 사용자를 생성
13. `06_make_admin_template.sql`의 관리자 이메일을 실제 값으로 변경한 뒤 실행
14. `08_verification_queries.sql`
15. `13_full_verification.sql`
16. `14_marketplace_legal_compliance.sql`
17. `15_fruit_specialization.sql`
18. `16_marketplace_operations_controls.sql`
19. `17_part46_verification.sql`
20. `18_policy_evidence_and_legal_holds.sql`
21. `19_mutual_fraud_and_abuse_protection.sql`
22. `20_part48_verification.sql`
23. 마지막으로 `08_verification_queries.sql`, `13_full_verification.sql`, `17_part46_verification.sql`, `20_part48_verification.sql`을 다시 실행

## 순서를 바꾸면 안 되는 구간

- `12 → 11`: 새 운영 테이블 생성 후 RLS를 적용합니다.
- `14 → 15 → 16`: 법적 고지, 과일 전문정보, 운영 게이트 순서입니다.
- `18 → 19 → 20`: 정책 동의·Legal Hold 기반을 만든 뒤 상호보호 구조를 설치하고 검증합니다.

## 중요 보안 원칙

- 브라우저에서는 주문·결제·환불·정산·위험심사 테이블을 직접 수정하지 않습니다.
- 주문금액·재고·환불·정산·최종 제재는 Edge Functions와 보안 RPC에서 처리합니다.
- `service_role`, Toss Secret Key, 지급대행 키는 Netlify 또는 공개 JavaScript에 넣지 않습니다.
- `part48_mutual_protection_readiness.release_ready`는 실제 담당인력·택배증거·오탐검토·이의제기 운영이 검증되기 전에는 `false`가 정상입니다.
